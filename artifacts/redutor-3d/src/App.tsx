import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  Box,
  CheckCircle2,
  CloudUpload,
  Download,
  FileBox,
  FileWarning,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  MousePointer2,
  Pause,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { buildStats } from './lib/mesh/geometry';
import { createMeshProcessor, downloadStl } from './lib/mesh/processor';
import type { MeshData, MeshStats, Quality, WorkerSuccess } from './lib/mesh/types';

type Vec3 = [number, number, number];
type AppPhase = 'empty' | 'ready' | 'processing' | 'complete' | 'error';
type Unit = 'mm' | 'cm' | 'in';

type MeshMeta = {
  name: string;
  format: string;
  bytes: number;
  stats: MeshStats;
  mesh: MeshData;
};
type Settings = {
  target: number;
  quality: Quality;
  borders: boolean;
  silhouette: boolean;
  details: boolean;
  unit: Unit;
};
type ReducedMeta = {
  stats: MeshStats;
  mesh: MeshData;
  stl: ArrayBuffer;
  warnings: string[];
};

const queryClient = new QueryClient();
const QUALITY_LABELS: Record<Quality, string> = {
  low: 'Rascunho',
  medium: 'Equilibrada',
  high: 'Preservação',
  ultra: 'Ultra',
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat('pt-BR').format(Math.round(value));
}

function faceNormal(mesh: MeshData, triangle: number): Vec3 {
  const { positions, indices } = mesh;
  const ai = indices[triangle * 3] * 3;
  const bi = indices[triangle * 3 + 1] * 3;
  const ci = indices[triangle * 3 + 2] * 3;
  const ab: Vec3 = [positions[bi] - positions[ai], positions[bi + 1] - positions[ai + 1], positions[bi + 2] - positions[ai + 2]];
  const ac: Vec3 = [positions[ci] - positions[ai], positions[ci + 1] - positions[ai + 1], positions[ci + 2] - positions[ai + 2]];
  const normal: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...normal) || 1;
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

function LogoMark() {
  return <div className="relative flex h-8 w-8 items-center justify-center border border-orange-400/50 bg-orange-500/10" aria-hidden="true"><span className="absolute h-4 w-4 rotate-45 border border-orange-400" /><span className="absolute h-1.5 w-1.5 bg-orange-400" /></div>;
}

function Header({ hasModel, onImport, onReset }: { hasModel: boolean; onImport: () => void; onReset: () => void }) {
  return <header className="relative z-10 flex h-[66px] items-center justify-between border-b border-white/[.08] px-5 md:px-8">
    <div className="flex items-center gap-3"><LogoMark /><div><div className="flex items-baseline gap-2"><span className="text-[15px] font-semibold tracking-[.12em]">REDUTOR</span><span className="mono text-[10px] text-orange-400">3D</span></div><div className="eyebrow mt-0.5 hidden sm:block">geometria local / estação 01</div></div></div>
    <div className="flex items-center gap-2 md:gap-4"><div className="hidden items-center gap-2 text-[10px] text-stone-600 sm:flex"><span className="h-1.5 w-1.5 bg-emerald-400" /> processamento local</div>{hasModel && <button className="button-secondary flex h-8 items-center gap-2 px-3 text-[11px]" onClick={onImport}><CloudUpload size={13} /> Novo modelo</button>}{hasModel && <button className="flex h-8 w-8 items-center justify-center border border-white/[.08] text-stone-500 transition hover:border-orange-400/40 hover:text-orange-300" onClick={onReset} aria-label="Limpar modelo"><X size={14} /></button>}</div>
  </header>;
}

function Dropzone({ onFiles, inputRef }: { onFiles: (files: FileList | null) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const [dragging, setDragging] = useState(false);
  return <div className={`group relative border p-8 transition md:p-12 ${dragging ? 'border-orange-400 bg-orange-500/[.08]' : 'border-white/[.12] bg-black/20 hover:border-orange-400/45'}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer.files); }}>
    <input ref={inputRef} type="file" accept=".stl,.obj,.ply,.off,.glb,.gltf,model/stl,model/obj,model/gltf-binary,model/gltf+json" className="hidden" onChange={(event) => onFiles(event.target.files)} data-testid="input-model-file" />
    <div className="pointer-events-none absolute inset-3 border border-dashed border-white/[.08]" />
    <div className="relative flex flex-col items-center text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center border border-orange-400/35 bg-orange-500/[.08] text-orange-300 transition group-hover:scale-105"><CloudUpload size={22} strokeWidth={1.5} /></div><div className="eyebrow mb-2 text-orange-400/80">entrada de geometria</div><h2 className="text-xl font-medium tracking-[-.03em] text-stone-100">Arraste seu modelo aqui</h2><p className="mt-2 max-w-sm text-xs leading-5 text-stone-600">O arquivo permanece neste dispositivo durante todo o processo.</p><button type="button" className="button-primary mt-7 flex h-10 items-center gap-2 px-5 text-xs font-semibold" onClick={() => inputRef.current?.click()}><CloudUpload size={14} /> Escolher arquivo</button><div className="mono mt-5 text-[9px] tracking-[.12em] text-stone-700">STL · OBJ · PLY · OFF · GLB · GLTF</div></div>
  </div>;
}

function EmptyState({ onFiles, inputRef }: { onFiles: (files: FileList | null) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  return <main className="relative mx-auto flex min-h-[calc(100dvh-66px)] max-w-[1320px] flex-col justify-center px-5 py-12 md:px-10"><div className="mb-8 flex items-end justify-between animate-in"><div><div className="eyebrow mb-3 text-orange-400/80">01 / entrada</div><h1 className="max-w-xl text-3xl font-medium tracking-[-.04em] text-stone-100 md:text-5xl">Reduza sem apagar<br /><span className="text-stone-500">o que importa.</span></h1></div><div className="hidden max-w-[210px] text-right text-xs leading-5 text-stone-600 md:block">Uma bancada silenciosa para transformar malha pesada em geometria pronta para imprimir.</div></div><div className="animate-in-delay"><Dropzone onFiles={onFiles} inputRef={inputRef} /></div><div className="mt-6 grid grid-cols-1 gap-px border border-white/[.06] bg-white/[.06] sm:grid-cols-3 animate-in-delay">{[{ icon: LockKeyhole, title: '100% local', copy: 'O arquivo nunca sai deste navegador.' }, { icon: ScanLine, title: 'Preservação guiada', copy: 'Contornos e detalhes sob o seu controle.' }, { icon: FileBox, title: 'STL validado', copy: 'Exportação binária pronta para fatiar.' }].map(({ icon: Icon, title, copy }) => <div key={title} className="bg-stone-950/75 p-4"><Icon size={15} className="mb-3 text-orange-400" /><div className="text-xs font-medium">{title}</div><div className="mt-1 text-[11px] text-stone-600">{copy}</div></div>)}</div></main>;
}

function MeshViewport({ original, reduced, comparing, processing }: { original: MeshData; reduced?: MeshData; comparing: boolean; processing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewMode, setViewMode] = useState<'solid' | 'wire'>('solid');
  const [rotation, setRotation] = useState<[number, number]>([0.42, 0.2]);
  const dragRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const data = comparing && reduced ? reduced : original;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const parent = canvas.parentElement;
    if (!context || !parent) return;
    const render = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      canvas.width = width * ratio; canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#0b0a09'; context.fillRect(0, 0, width, height);
      if (!data.indices.length) return;
      const { min, max } = data.bounds;
      const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const span = Math.max(...data.bounds.size) || 1;
      const [yaw, pitch] = rotation;
      const project = (index: number): [number, number, number] => {
        const at = index * 3;
        let x = (data.positions[at] - center[0]) / span;
        let y = (data.positions[at + 1] - center[1]) / span;
        let z = (data.positions[at + 2] - center[2]) / span;
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
        const rx = x * cosY - z * sinY; const rz = x * sinY + z * cosY;
        const cosX = Math.cos(pitch), sinX = Math.sin(pitch);
        const ry = y * cosX - rz * sinX; const depth = y * sinX + rz * cosX;
        return [width / 2 + rx * width * .78, height / 2 - ry * height * .78, depth];
      };
      const triangles = data.indices.length / 3;
      const step = Math.max(1, Math.floor(triangles / 2600));
      context.lineJoin = 'round'; context.lineWidth = 1;
      for (let triangle = 0; triangle < triangles; triangle += step) {
        const ia = data.indices[triangle * 3], ib = data.indices[triangle * 3 + 1], ic = data.indices[triangle * 3 + 2];
        const a = project(ia), b = project(ib), c = project(ic);
        const n = faceNormal(data, triangle);
        const light = Math.max(.1, Math.min(1, .48 + n[0] * .24 + n[1] * .3 + n[2] * .2));
        context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.lineTo(c[0], c[1]); context.closePath();
        if (viewMode === 'solid') { context.fillStyle = `rgba(221, ${Math.round(76 + light * 42)}, ${Math.round(27 + light * 22)}, ${.08 + light * .16})`; context.fill(); }
        context.strokeStyle = comparing ? `rgba(255, 145, 70, ${.19 + light * .3})` : `rgba(215, 95, 39, ${.16 + light * .28})`; context.stroke();
      }
      context.strokeStyle = 'rgba(244, 123, 57, .35)'; context.lineWidth = 1; context.beginPath(); context.moveTo(24, height - 28); context.lineTo(84, height - 28); context.stroke(); context.fillStyle = 'rgba(181, 174, 165, .48)'; context.font = '10px DM Mono'; context.fillText('eixo X', 88, height - 25);
    };
    render();
    const observer = new ResizeObserver(render); observer.observe(parent);
    return () => observer.disconnect();
  }, [data, comparing, processing, rotation, viewMode]);

  return <div className="relative h-full min-h-[420px] overflow-hidden border border-white/[.08] bg-[#0b0a09]" data-testid="viewport-mesh" onPointerDown={(event) => { dragRef.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!dragRef.current) return; setRotation(([yaw, pitch]) => [yaw + (event.clientX - dragRef.current!.x) * .008, Math.max(-1.1, Math.min(1.1, pitch + (event.clientY - dragRef.current!.y) * .008))]); dragRef.current = { x: event.clientX, y: event.clientY }; }} onPointerUp={() => { dragRef.current = undefined; }} onPointerCancel={() => { dragRef.current = undefined; }}>
    <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" /><div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,.28) 100%)' }} /><div className="absolute left-4 top-4 flex items-center gap-2"><span className="h-1.5 w-1.5 bg-orange-400" /><span className="eyebrow text-stone-400">{processing ? 'analisando malha' : comparing ? 'malha reduzida' : 'malha original'}</span></div><div className="absolute right-3 top-3 flex gap-1 border border-white/10 bg-black/45 p-1"><button className={`px-2 py-1 text-[10px] ${viewMode === 'solid' ? 'bg-orange-500/20 text-orange-300' : 'text-stone-600'}`} onClick={() => setViewMode('solid')} data-testid="button-view-solid">Sólido</button><button className={`px-2 py-1 text-[10px] ${viewMode === 'wire' ? 'bg-orange-500/20 text-orange-300' : 'text-stone-600'}`} onClick={() => setViewMode('wire')} data-testid="button-view-wire">Wire</button></div><div className="absolute bottom-4 right-4 flex items-center gap-2 text-[10px] text-stone-600"><MousePointer2 size={12} /> arraste para orbitar <Maximize2 size={12} /></div>{processing && <div className="processing-line absolute bottom-0 left-0 h-px w-full bg-orange-400" />}
  </div>;
}

function MetaLine({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="flex items-center justify-between py-1 text-xs"><span className="text-stone-600">{label}</span><span className={accent ? 'mono text-orange-300' : 'mono text-stone-300'}>{value}</span></div>;
}

function Toggle({ label, caption, checked, onChange, testId }: { label: string; caption: string; checked: boolean; onChange: (value: boolean) => void; testId: string }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-white/[.055] py-3 last:border-b-0"><span><span className="block text-xs text-stone-300">{label}</span><span className="mt-0.5 block text-[10px] text-stone-600">{caption}</span></span><button type="button" role="switch" aria-checked={checked} className={`relative h-5 w-9 shrink-0 border transition ${checked ? 'border-orange-400/80 bg-orange-500/20' : 'border-stone-700 bg-stone-900'}`} onClick={() => onChange(!checked)} data-testid={testId}><span className={`absolute top-0.5 h-3.5 w-3.5 transition-transform ${checked ? 'translate-x-[17px] bg-orange-400' : 'translate-x-0.5 bg-stone-600'}`} /></button></label>;
}

function SettingsPanel({ settings, setSettings, disabled, maxTarget }: { settings: Settings; setSettings: (next: Settings) => void; disabled: boolean; maxTarget: number }) {
  const updateTarget = (target: number) => setSettings({ ...settings, target: Math.max(4, Math.min(maxTarget, Math.floor(target) || 4)) });
  return <section className="panel p-4" aria-label="Controles de otimização"><div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><SlidersHorizontal size={15} className="text-orange-400" /><span className="text-sm font-medium">Otimização</span></div><span className="eyebrow">parâmetros</span></div><label className="block"><div className="mb-2 flex items-center justify-between text-xs"><span className="text-stone-400">Triângulos alvo</span><span className="mono text-orange-300" data-testid="text-target-triangles">{formatCount(settings.target)}</span></div><input className="w-full accent-orange-500" type="range" min="4" max={maxTarget} step="1" value={settings.target} disabled={disabled} onChange={(event) => updateTarget(Number(event.target.value))} data-testid="input-target-triangles" /><input className="field mt-3 h-9 px-2 mono text-xs" type="number" min="4" max={maxTarget} value={settings.target} disabled={disabled} onChange={(event) => updateTarget(Number(event.target.value))} aria-label="Quantidade máxima de triângulos" /><div className="mt-1 flex justify-between mono text-[9px] text-stone-700"><span>4</span><span>{formatCount(maxTarget)}</span></div></label><div className="mt-5"><div className="mb-2 text-xs text-stone-400">Prioridade de redução</div><div className="grid grid-cols-2 gap-1">{(Object.keys(QUALITY_LABELS) as Quality[]).map((quality) => <button key={quality} className={`border px-2 py-2 text-left transition ${settings.quality === quality ? 'border-orange-400/60 bg-orange-500/10 text-orange-300' : 'border-white/[.07] bg-black/10 text-stone-500 hover:border-white/20'}`} onClick={() => setSettings({ ...settings, quality })} disabled={disabled} data-testid={`button-quality-${quality}`}><span className="block text-[11px]">{QUALITY_LABELS[quality]}</span><span className="mono text-[9px] text-stone-600">{quality === 'low' ? 'velocidade' : quality === 'ultra' ? 'máxima forma' : quality === 'high' ? 'forma' : 'equilíbrio'}</span></button>)}</div></div><div className="mt-4 border-t border-white/[.06] pt-1"><Toggle label="Preservar bordas" caption="Mantém arestas nítidas" checked={settings.borders} onChange={(borders) => setSettings({ ...settings, borders })} testId="toggle-preserve-borders" /><Toggle label="Preservar silhueta" caption="Protege o contorno externo" checked={settings.silhouette} onChange={(silhouette) => setSettings({ ...settings, silhouette })} testId="toggle-preserve-silhouette" /><Toggle label="Proteger detalhes" caption="Áreas de alta curvatura" checked={settings.details} onChange={(details) => setSettings({ ...settings, details })} testId="toggle-protect-details" /></div><div className="mt-3 flex items-center justify-between"><span className="text-xs text-stone-500">Unidade de trabalho</span><div className="flex border border-white/[.08] p-0.5">{(['mm', 'cm', 'in'] as Unit[]).map((unit) => <button key={unit} className={`px-2 py-1 text-[10px] ${settings.unit === unit ? 'bg-white/10 text-stone-200' : 'text-stone-600'}`} onClick={() => setSettings({ ...settings, unit })} disabled={disabled} data-testid={`button-unit-${unit}`}>{unit}</button>)}</div></div></section>;
}

function FilePanel({ model, reduced }: { model: MeshMeta; reduced?: ReducedMeta }) {
  return <section className="panel p-4" aria-label="Informações do modelo"><div className="mb-3 flex items-center gap-2"><FileBox size={15} className="text-orange-400" /><span className="text-sm font-medium">Modelo carregado</span></div><div className="flex min-w-0 items-center gap-3 border-b border-white/[.06] pb-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center border border-orange-400/25 bg-orange-500/10 text-orange-300"><Box size={16} /></div><div className="min-w-0"><div className="truncate text-xs text-stone-200" data-testid="text-source-name">{model.name}</div><div className="mono mt-1 text-[10px] text-stone-600">{model.format} · {formatBytes(model.bytes)}</div></div></div><div className="mt-2"><MetaLine label="Triângulos" value={formatCount(model.stats.triangles)} /><MetaLine label="Vértices" value={formatCount(model.stats.vertices)} /><MetaLine label="Dimensões" value={model.stats.bounds.size.map((v) => v.toFixed(2)).join(' × ')} /></div>{reduced && <div className="mt-3 border-t border-orange-400/15 pt-3"><div className="mb-1 flex items-center justify-between"><span className="eyebrow text-orange-400/80">resultado</span><CheckCircle2 size={14} className="text-orange-400" /></div><MetaLine label="Reduzidos" value={formatCount(reduced.stats.triangles)} accent /><MetaLine label="Redução" value={`${Math.max(0, (1 - reduced.stats.triangles / model.stats.triangles) * 100).toFixed(1)}%`} accent /><MetaLine label="STL binário" value={formatBytes(reduced.stl.byteLength)} accent /></div>}</section>;
}

function ProcessingView({ model, progress, message, onCancel }: { model: MeshMeta; progress: number; message: string; onCancel: () => void }) {
  return <div className="mx-auto grid min-h-[calc(100dvh-66px)] max-w-[1320px] grid-cols-1 content-center gap-6 px-5 py-10 md:px-10 lg:grid-cols-[1fr_370px]"><div className="panel relative min-h-[470px] overflow-hidden bg-black/25 p-8 md:p-12"><MeshViewport original={model.mesh} processing comparing={false} /><div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="border border-orange-400/25 bg-black/75 px-5 py-4 backdrop-blur-sm"><div className="flex items-center gap-3"><LoaderCircle size={16} className="spinner text-orange-400" /><span className="eyebrow text-orange-300">{message}</span></div></div></div></div><div className="flex flex-col justify-center"><div className="eyebrow mb-3 text-orange-400/80">02 / processamento</div><h1 className="text-3xl font-medium tracking-[-.04em]">A forma está sendo<br /><span className="text-stone-500">recalculada.</span></h1><p className="mt-4 text-sm leading-6 text-stone-500">O Redutor está analisando a topologia e redistribuindo a malha no seu dispositivo.</p><div className="mt-10"><div className="mb-2 flex items-end justify-between"><span className="mono text-[11px] text-stone-600">progresso local</span><span className="mono text-2xl text-orange-300" data-testid="text-processing-progress">{Math.round(progress)}%</span></div><div className="h-1 bg-stone-800"><div className="h-1 bg-orange-400 transition-[width] duration-150" style={{ width: `${progress}%` }} /></div><div className="mt-4 grid grid-cols-3 gap-2 text-[10px] text-stone-600"><span className={progress > 15 ? 'text-orange-300' : ''}>ler malha</span><span className={progress > 48 ? 'text-orange-300' : ''}>otimizar</span><span className={progress > 90 ? 'text-orange-300' : ''}>validar</span></div></div><button className="button-secondary mt-10 flex h-10 items-center justify-center gap-2 text-xs" onClick={onCancel} data-testid="button-cancel-processing"><Pause size={14} /> Cancelar processamento</button><div className="mt-5 flex items-center gap-2 text-[10px] text-stone-600"><LockKeyhole size={12} /> nada é enviado para a nuvem</div></div></div>;
}

function ErrorState({ message, onReset }: { message: string; onReset: () => void }) {
  return <main className="mx-auto flex min-h-[calc(100dvh-66px)] max-w-[720px] flex-col items-center justify-center px-5 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center border border-red-400/35 bg-red-500/[.08] text-red-300"><FileWarning size={24} /></div><div className="eyebrow mb-3 text-red-300/80">entrada recusada</div><h1 className="text-3xl font-medium tracking-[-.04em]">Esse arquivo não pôde ser lido.</h1><p className="mt-3 max-w-md text-sm leading-6 text-stone-500" data-testid="status-file-error">{message}</p><div className="mt-8 flex gap-2"><button className="button-primary flex h-10 items-center gap-2 px-4 text-xs font-semibold" onClick={onReset} data-testid="button-try-again"><RefreshCw size={14} /> Tentar outro arquivo</button></div><p className="mt-6 mono text-[10px] text-stone-700">formatos aceitos / .STL .OBJ .PLY .OFF .GLB .GLTF</p></main>;
}

function ImportingView({ progress, message }: { progress: number; message: string }) {
  return <main className="mx-auto flex min-h-[calc(100dvh-66px)] max-w-[720px] flex-col items-center justify-center px-5 text-center"><LoaderCircle size={25} className="spinner mb-5 text-orange-400" /><div className="eyebrow mb-3 text-orange-400/80">01 / leitura</div><h1 className="text-3xl font-medium tracking-[-.04em]">Preparando sua<br /><span className="text-stone-500">geometria.</span></h1><p className="mt-4 max-w-md text-sm leading-6 text-stone-500">{message}</p><div className="mt-9 h-1 w-full max-w-sm bg-stone-800"><div className="h-1 bg-orange-400 transition-[width] duration-150" style={{ width: `${progress}%` }} /></div><div className="mono mt-3 text-[10px] text-stone-600">{Math.round(progress)}% · local</div></main>;
}

function Workspace({ model, reduced, settings, setSettings, onOptimize, onReset, comparing, setComparing, notice }: { model: MeshMeta; reduced?: ReducedMeta; settings: Settings; setSettings: (settings: Settings) => void; onOptimize: () => void; onReset: () => void; comparing: boolean; setComparing: (value: boolean) => void; notice: string }) {
  const maxTarget = Math.max(200000, model.stats.triangles);
  const canOptimize = !reduced && model.stats.triangles > 4 && settings.target < model.stats.triangles;
  return <main className="relative mx-auto max-w-[1480px] px-4 py-5 md:px-7 lg:px-10"><div className="mb-5 flex flex-wrap items-end justify-between gap-4"><div><div className="eyebrow mb-2 text-orange-400/80">{reduced ? '03 / resultado' : '02 / preparação'}</div><h1 className="text-2xl font-medium tracking-[-.035em] md:text-3xl">{reduced ? 'Malha pronta para sair.' : 'Configure a redução.'}</h1></div><div className="flex items-center gap-3"><div className="hidden items-center gap-2 text-[10px] text-stone-600 md:flex"><span className="h-1.5 w-1.5 bg-emerald-400" /> modelo válido</div><button className="button-secondary flex h-9 items-center gap-2 px-3 text-xs" onClick={onReset} data-testid="button-reset-workspace"><X size={14} /> Limpar</button></div></div>{notice && <div className="mb-4 border border-orange-400/20 bg-orange-500/[.06] px-3 py-2 text-xs text-orange-200">{notice}</div>}<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]"><div className="min-w-0"><MeshViewport original={model.mesh} reduced={reduced?.mesh} comparing={comparing} processing={false} /><div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-white/[.07] bg-black/20 px-3 py-2"><div className="flex items-center gap-4 text-[10px] text-stone-600"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-orange-500" /> faces</span><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 border border-stone-500" /> wireframe</span></div>{reduced && <button className="flex items-center gap-2 text-xs text-stone-400 transition hover:text-orange-300" onClick={() => setComparing(!comparing)} data-testid="button-toggle-comparison"><span className={`flex h-4 w-7 items-center border ${comparing ? 'border-orange-400 bg-orange-500/20' : 'border-stone-700'}`}><span className={`h-3 w-3 bg-orange-400 transition-transform ${comparing ? 'translate-x-[13px]' : 'translate-x-0.5'}`} /></span>{comparing ? 'Exibindo reduzida' : 'Comparar com original'}</button>}</div></div><aside className="space-y-4"><FilePanel model={model} reduced={reduced} />{!reduced && <SettingsPanel settings={settings} setSettings={setSettings} disabled={false} maxTarget={maxTarget} />}{reduced ? <div className="panel border-orange-400/25 bg-orange-500/[.045] p-4"><div className="flex items-center gap-2 text-sm text-orange-200"><ShieldCheck size={16} /> Validação concluída</div><p className="mt-2 text-xs leading-5 text-stone-500">O STL binário foi verificado e está pronto para ser usado no seu fatiador.</p>{reduced.warnings.length > 0 && <p className="mt-3 border-l border-orange-400/50 pl-2 text-[10px] leading-4 text-orange-200/70">{reduced.warnings.join(' ')}</p>}<button className="button-primary mt-4 flex h-11 w-full items-center justify-center gap-2 text-xs font-semibold" onClick={() => downloadStl(reduced.stl, model.name)} data-testid="button-export-stl"><Download size={15} /> Exportar STL validado</button></div> : <div className="panel p-4"><button className="button-primary flex h-12 w-full items-center justify-center gap-2 text-xs font-semibold disabled:opacity-50" disabled={!canOptimize} onClick={onOptimize} data-testid="button-optimize-model"><Zap size={16} /> Otimizar modelo <span className="mono ml-auto text-[10px] opacity-60">⌘ ↵</span></button>{!canOptimize && <p className="mt-2 text-center text-[10px] text-stone-600">{model.stats.triangles <= 4 ? 'A malha já é pequena demais para reduzir.' : 'Defina um alvo menor que a malha original.'}</p>}</div>}</aside></div></main>;
}

function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<File | undefined>(undefined);
  const processorRef = useRef<ReturnType<typeof createMeshProcessor> | undefined>(undefined);
  const [phase, setPhase] = useState<AppPhase>('empty');
  const [model, setModel] = useState<MeshMeta>();
  const [reduced, setReduced] = useState<ReducedMeta>();
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('preparando malha');
  const [comparing, setComparing] = useState(false);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState<Settings>({ target: 200000, quality: 'high', borders: true, silhouette: true, details: true, unit: 'mm' });

  const reset = useCallback(() => {
    processorRef.current?.cancel();
    fileRef.current = undefined;
    setPhase('empty'); setModel(undefined); setReduced(undefined); setError(''); setProgress(0); setComparing(false); setNotice('');
  }, []);

  const runProcessor = useCallback(async (file: File, targetTriangles: number, isImport: boolean) => {
    processorRef.current?.cancel();
    const processor = createMeshProcessor();
    processorRef.current = processor;
    setPhase('processing'); setProgress(2); setMessage(isImport ? 'lendo estrutura do arquivo' : 'analisando topologia'); setError(''); setNotice('');
    processor.process(await file.arrayBuffer(), file.name, { targetTriangles, quality: settings.quality, preserveBorders: settings.borders, preserveSilhouette: settings.silhouette, protectDetails: settings.details }, (event) => {
      if (event.type === 'progress') {
        setProgress(Math.round(event.data.progress * 100));
        setMessage(event.data.message.replace('…', ''));
      } else if (event.type === 'complete') {
        const result: WorkerSuccess = event.data;
        if (isImport) {
          const imported: MeshData = { positions: result.positions, indices: result.indices, format: result.format, bounds: result.original.bounds };
          const importedStats = buildStats(imported);
          setModel({ name: file.name, format: result.format, bytes: file.size, stats: importedStats, mesh: imported });
          setSettings((current) => ({ ...current, target: Math.min(200000, importedStats.triangles) }));
          setPhase('ready'); setProgress(0);
        } else if (model) {
          const reducedMesh: MeshData = { positions: result.positions, indices: result.indices, format: result.format, bounds: result.reduced.bounds };
          setReduced({ stats: result.reduced, mesh: reducedMesh, stl: result.stl.buffer, warnings: result.warnings });
          setComparing(true); setProgress(100); setPhase('complete');
        }
        processorRef.current = undefined;
      } else {
        console.error('Mesh processor error', event.data.technical);
        setError(event.data.message); setPhase('error'); setProgress(0); processorRef.current = undefined;
      }
    });
  }, [model, settings]);

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    fileRef.current = file;
    void runProcessor(file, Number.MAX_SAFE_INTEGER, true);
  }, [runProcessor]);

  const optimize = useCallback(() => {
    if (!model || !fileRef.current) return;
    setReduced(undefined);
    void runProcessor(fileRef.current, settings.target, false);
  }, [model, runProcessor, settings.target]);

  const cancel = useCallback(() => {
    processorRef.current?.cancel();
    processorRef.current = undefined;
    setPhase(model ? 'ready' : 'empty'); setProgress(0); setNotice('Processamento cancelado. O arquivo original não foi alterado.');
  }, [model]);

  useEffect(() => () => { processorRef.current?.cancel(); }, []);

  return <div className="app-shell dark"><Header hasModel={phase !== 'empty' && phase !== 'error'} onImport={() => inputRef.current?.click()} onReset={reset} />{phase === 'empty' && <EmptyState onFiles={handleFiles} inputRef={inputRef} />}{phase === 'error' && <><input ref={inputRef} type="file" accept=".stl,.obj,.ply,.off,.glb,.gltf" className="hidden" onChange={(event) => handleFiles(event.target.files)} data-testid="input-error-file" /><ErrorState message={error} onReset={() => inputRef.current?.click()} /></>}{phase === 'processing' && (model ? <ProcessingView model={model} progress={progress} message={message} onCancel={cancel} /> : <ImportingView progress={progress} message={message} />)}{(phase === 'ready' || phase === 'complete') && model && <Workspace model={model} reduced={reduced} settings={settings} setSettings={setSettings} onOptimize={optimize} onReset={reset} comparing={comparing} setComparing={setComparing} notice={notice} />}<footer className="pointer-events-none fixed bottom-3 left-5 right-5 z-10 flex justify-between mono text-[9px] text-stone-700 md:left-8 md:right-8"><span>REDUTOR / BUILD 1.0.0</span><span className="hidden sm:block">WORKER QEM · LOCAL FIRST</span></footer></div>;
}

function Router() {
  return <Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary resetKey={useLocation()[0]}><Router /></ErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;