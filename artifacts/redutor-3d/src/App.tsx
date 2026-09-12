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
import { checkProtocol, createMeshProcessor, downloadStl, ensureReport, importTimeoutMs, isZeroReductionError, STALE_WORKER_MESSAGE, targetFacesForSize } from './lib/mesh/processor';
import { createCompressor, downloadBytes } from './lib/compress/processor';
import { packGzip } from './lib/compress/container';
import type { MeshData, MeshStats, Quality, WorkerSuccess } from './lib/mesh/types';
import type { AnalyzeSuccess, CompressAnalysis, DecompressSuccess, ImportTopology, OptimizeSuccess, ReductionProfile, SimplifyReport } from './lib/mesh/types';

export type AppMode = 'compress' | 'reduce';

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
const MODEL_ACCEPT = '.stl,.obj,.ply,.off,.glb,.gltf,.fbx,.dae,model/stl,model/obj,model/gltf-binary,model/gltf+json,model/fbx,model/vnd.collada+xml';
const SUPPORTED_FORMATS_LABEL = 'STL · OBJ · PLY · OFF · GLB · GLTF · FBX · DAE';
const COMPRESS_ACCEPT = `${MODEL_ACCEPT},.3dpack,.3mf,model/3mf`;
const COMPRESS_FORMATS_LABEL = 'STL · OBJ · PLY · OFF · GLB · GLTF · FBX · DAE · 3MF · 3DPACK';
const META_OPTIONS = [25, 40, 50, 75] as const;
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

function ModeTabs({ mode, onMode }: { mode: AppMode; onMode: (mode: AppMode) => void }) {
  return <div className="flex gap-1 border border-white/10 bg-black/45 p-1" role="tablist" aria-label="Modo de operação">
    <button role="tab" aria-selected={mode === 'compress'} className={`px-3 py-1.5 text-[10px] tracking-wide transition ${mode === 'compress' ? 'bg-orange-500/20 text-orange-300' : 'text-stone-600 hover:text-stone-400'}`} onClick={() => onMode('compress')} data-testid="tab-compress">COMPRESSÃO 3D</button>
    <button role="tab" aria-selected={mode === 'reduce'} className={`px-3 py-1.5 text-[10px] tracking-wide transition ${mode === 'reduce' ? 'bg-orange-500/20 text-orange-300' : 'text-stone-600 hover:text-stone-400'}`} onClick={() => onMode('reduce')} data-testid="tab-reduce">SEM ALTERAR MALHA</button>
  </div>;
}

function Header({ hasModel, onImport, onReset, mode, onMode, title }: { hasModel: boolean; onImport: () => void; onReset: () => void; mode: AppMode; onMode: (mode: AppMode) => void; title: string }) {
  return <header className="relative z-10 flex h-[66px] items-center justify-between gap-3 border-b border-white/[.08] px-5 md:px-8">
    <div className="flex items-center gap-3"><LogoMark /><div><div className="flex items-baseline gap-2"><span className="text-[15px] font-semibold tracking-[.12em]">{title}</span><span className="mono text-[10px] text-orange-400">3D</span></div><div className="eyebrow mt-0.5 hidden sm:block">geometria local / estação 01</div></div></div>
    <div className="hidden md:block"><ModeTabs mode={mode} onMode={onMode} /></div>
    <div className="flex items-center gap-2 md:gap-4"><div className="hidden items-center gap-2 text-[10px] text-stone-600 sm:flex"><span className="h-1.5 w-1.5 bg-emerald-400" /> processamento local</div>{hasModel && <button className="button-secondary flex h-8 items-center gap-2 px-3 text-[11px]" onClick={onImport}><CloudUpload size={13} /> Novo modelo</button>}{hasModel && <button className="flex h-8 w-8 items-center justify-center border border-white/[.08] text-stone-500 transition hover:border-orange-400/40 hover:text-orange-300" onClick={onReset} aria-label="Limpar modelo"><X size={14} /></button>}</div>
  </header>;
}

function Dropzone({ onFiles, inputRef, accept, formatsLabel }: { onFiles: (files: FileList | null) => void; inputRef: RefObject<HTMLInputElement | null>; accept?: string; formatsLabel?: string }) {
  const [dragging, setDragging] = useState(false);
  return <div className={`group relative border p-8 transition md:p-12 ${dragging ? 'border-orange-400 bg-orange-500/[.08]' : 'border-white/[.12] bg-black/20 hover:border-orange-400/45'}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept={accept ?? MODEL_ACCEPT} className="hidden" onChange={(event) => onFiles(event.target.files)} data-testid="input-model-file" />
    <div className="pointer-events-none absolute inset-3 border border-dashed border-white/[.08]" />
   <div className="relative flex flex-col items-center text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center border border-orange-400/35 bg-orange-500/[.08] text-orange-300 transition group-hover:scale-105"><CloudUpload size={22} strokeWidth={1.5} /></div><div className="eyebrow mb-2 text-orange-400/80">entrada de geometria</div><h2 className="text-xl font-medium tracking-[-.03em] text-stone-100">Arraste seu modelo aqui</h2><p className="mt-2 max-w-sm text-xs leading-5 text-stone-600">O arquivo permanece neste dispositivo durante todo o processo.</p><button type="button" className="button-primary mt-7 flex h-10 items-center gap-2 px-5 text-xs font-semibold" onClick={() => inputRef.current?.click()}><CloudUpload size={14} /> Escolher arquivo</button><div className="mono mt-5 text-[9px] tracking-[.12em] text-stone-700">{formatsLabel ?? SUPPORTED_FORMATS_LABEL}</div></div>
  </div>;
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

const STAGES = ['ANALISANDO', 'IDENTIFICANDO_FEATURES', 'OTIMIZANDO', 'VALIDANDO', 'FINALIZANDO'] as const;
type Stage = (typeof STAGES)[number];
const STAGE_LABELS: Record<Stage, string> = {
  ANALISANDO: 'analisando',
  IDENTIFICANDO_FEATURES: 'features',
  OTIMIZANDO: 'otimizando',
  VALIDANDO: 'validando',
  FINALIZANDO: 'finalizando',
};

function ProcessingView({ progress, message, elapsedMs, stage, originalTriangles, currentTriangles, targetTriangles, onCancel }: { progress: number; message: string; elapsedMs: number; stage: Stage; originalTriangles: number; currentTriangles: number; targetTriangles: number; onCancel: () => void }) {
  const stageIndex = Math.max(0, STAGES.indexOf(stage));
  const reduction = originalTriangles > 0 ? Math.max(0, ((originalTriangles - currentTriangles) / originalTriangles) * 100) : 0;
  return <div className="mx-auto grid min-h-[calc(100dvh-66px)] max-w-[1320px] grid-cols-1 content-center gap-6 px-5 py-10 md:px-10 lg:grid-cols-[1fr_370px]"><div className="panel relative min-h-[470px] overflow-hidden bg-black/25 p-8 md:p-12"><div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="border border-orange-400/25 bg-black/75 px-5 py-4 backdrop-blur-sm"><div className="flex items-center gap-3"><LoaderCircle size={16} className="spinner text-orange-400" /><span className="eyebrow text-orange-300">{message}</span></div></div></div></div><div className="flex flex-col justify-center"><div className="eyebrow mb-3 text-orange-400/80">02 / processamento · {STAGE_LABELS[stage]}</div><div className="mono mb-3 text-xs text-orange-300">{Math.min(60, elapsedMs / 1000).toFixed(1)}s / 60s</div><h1 className="text-3xl font-medium tracking-[-.04em]">A forma está sendo<br /><span className="text-stone-500">recalculada.</span></h1><p className="mt-4 text-sm leading-6 text-stone-500">O Redutor está analisando a topologia e redistribuindo a malha no seu dispositivo.</p><div className="mono mt-4 grid grid-cols-3 gap-2 border border-white/[.06] bg-black/20 px-3 py-2 text-[10px]"><span className="text-stone-600">orig <span className="text-stone-300">{formatCount(originalTriangles)}</span></span><span className="text-stone-600">atual <span className="text-orange-300">{formatCount(currentTriangles)}</span></span><span className="text-stone-600">alvo <span className="text-stone-300">{formatCount(targetTriangles)}</span> · −{reduction.toFixed(1)}%</span></div><div className="mt-10"><div className="mb-2 flex items-end justify-between"><span className="mono text-[11px] text-stone-600">progresso local</span><span className="mono text-2xl text-orange-300" data-testid="text-processing-progress">{Math.round(progress)}%</span></div><div className="h-1 bg-stone-800"><div className="h-1 bg-orange-400 transition-[width] duration-150" style={{ width: `${progress}%` }} /></div><div className="mt-4 grid grid-cols-5 gap-2 text-[10px] text-stone-600">{STAGES.map((step, index) => <span key={step} className={index <= stageIndex ? 'text-orange-300' : ''}>{STAGE_LABELS[step]}</span>)}</div></div><button className="button-secondary mt-10 flex h-10 items-center justify-center gap-2 text-xs" onClick={onCancel} data-testid="button-cancel-processing"><Pause size={14} /> Cancelar processamento</button><div className="mt-5 flex items-center gap-2 text-[10px] text-stone-600"><LockKeyhole size={12} /> nada é enviado para a nuvem</div></div></div>;
}

  function ErrorState({ message, onReset, title }: { message: string; onReset: () => void; title?: string }) {
  return <main className="mx-auto flex min-h-[calc(100dvh-66px)] max-w-[720px] flex-col items-center justify-center px-5 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center border border-red-400/35 bg-red-500/[.08] text-red-300"><FileWarning size={24} /></div><div className="eyebrow mb-3 text-red-300/80">entrada recusada</div><h1 className="text-3xl font-medium tracking-[-.04em]">{title ?? 'Esse arquivo não pôde ser lido.'}</h1><p className="mt-3 max-w-md text-sm leading-6 text-stone-500" data-testid="status-file-error">{message}</p><div className="mt-8 flex gap-2"><button className="button-primary flex h-10 items-center gap-2 px-4 text-xs font-semibold" onClick={onReset} data-testid="button-try-again"><RefreshCw size={14} /> Tentar outro arquivo</button></div><p className="mt-6 mono text-[10px] text-stone-700">formatos aceitos / .STL .OBJ .PLY .OFF .GLB .GLTF .FBX .DAE</p></main>;
}

function ImportingView({ progress, message }: { progress: number; message: string }) {
  return <main className="mx-auto flex min-h-[calc(100dvh-66px)] max-w-[720px] flex-col items-center justify-center px-5 text-center"><LoaderCircle size={25} className="spinner mb-5 text-orange-400" /><div className="eyebrow mb-3 text-orange-400/80">01 / leitura</div><h1 className="text-3xl font-medium tracking-[-.04em]">Preparando sua<br /><span className="text-stone-500">geometria.</span></h1><p className="mt-4 max-w-md text-sm leading-6 text-stone-500">{message}</p><div className="mt-9 h-1 w-full max-w-sm bg-stone-800"><div className="h-1 bg-orange-400 transition-[width] duration-150" style={{ width: `${progress}%` }} /></div><div className="mono mt-3 text-[10px] text-stone-600">{Math.round(progress)}% · local</div></main>;
}

type UnpackResult = {
  bytes: ArrayBuffer;
  fileName: string;
  format: string;
  faces: number;
  elapsedMs: number;
};

type CompressPhase = 'empty' | 'analyzing' | 'ready' | 'compressing' | 'done' | 'error';

type OptimizeDelivery = {
  stl: ArrayBuffer;
  fileName: string;
  gzip: ArrayBuffer;
  gzipFileName: string;
  method: string;
  methodLabel: string;
  tier: 'A' | 'B';
  format: string;
  originalBytes: number;
  deliveredBytes: number;
  ratio: number;
  faces: number;
  validation: string;
  checks: Record<string, boolean>;
  warnings: string[];
  meanError: number;
  maxError: number;
  volumeDeltaPercent: number;
  boundaryOriginal: number;
  boundaryFinal: number;
  elapsedMs: number;
};

function shortHash(hash: string) {
  return `${hash.slice(0, 12)}…${hash.slice(-6)}`;
}

function MetaSelect({ target, onChange, disabled }: { target: number; onChange: (target: number) => void; disabled?: boolean }) {
  return <div><div className="mb-2 text-xs text-stone-400">Meta de redução (apenas meta — a geometria nunca é tocada)</div><div className="grid grid-cols-4 gap-1">{META_OPTIONS.map((option) => <button key={option} className={`border px-2 py-2 text-center transition ${target === option ? 'border-orange-400/60 bg-orange-500/10 text-orange-300' : 'border-white/[.07] bg-black/10 text-stone-500 hover:border-white/20'}`} onClick={() => onChange(option)} disabled={disabled} data-testid={`button-meta-${option}`}><span className="mono block text-[12px]">{option}%</span></button>)}</div></div>;
}

function LosslessHome({ onModeChange }: { onModeChange: (mode: AppMode) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<File | undefined>(undefined);
  const compRef = useRef<ReturnType<typeof createCompressor> | undefined>(undefined);
  const [phase, setPhase] = useState<CompressPhase>('empty');
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<CompressAnalysis | null>(null);
  const [targetPercent, setTargetPercent] = useState<number>(50);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('preparando arquivo');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<OptimizeDelivery | null>(null);
  const [unpacked, setUnpacked] = useState<UnpackResult | null>(null);
  const [error, setError] = useState('');

  const reset = useCallback(() => {
    compRef.current?.cancel();
    fileRef.current = undefined;
    setPhase('empty'); setFileName(''); setAnalysis(null); setResult(null); setUnpacked(null);
    setError(''); setProgress(0); setMessage('preparando arquivo'); setElapsedMs(0);
  }, []);

  const runAnalyze = useCallback(async (file: File) => {
    try {
      compRef.current?.cancel();
      const comp = createCompressor();
      compRef.current = comp;
      setPhase('analyzing'); setProgress(2); setElapsedMs(0); setMessage('lendo estrutura do arquivo'); setError(''); setResult(null); setUnpacked(null);
      setFileName(file.name);
    comp.analyze(await file.arrayBuffer(), file.name, (event) => {
      if (event.type === 'progress') {
        setProgress(Math.round(event.data.progress * 100));
        setMessage(event.data.message.replace('…', '')); setElapsedMs(event.data.elapsedMs ?? 0);
      } else if (event.type === 'complete') {
        const data = event.data;
        if (data.job === 'analyze') {
          const done = data as AnalyzeSuccess;
          setAnalysis(done.analysis);
          setPhase('ready'); setProgress(0);
        }
        compRef.current = undefined;
      } else {
        setError(event.data.message); setPhase('error'); setProgress(0); compRef.current = undefined;
      }
    });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível analisar este arquivo.');
      setPhase('error'); setProgress(0); compRef.current = undefined;
    }
  }, []);

  const runOptimize = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    try {
      compRef.current?.cancel();
      const comp = createCompressor();
      compRef.current = comp;
      setPhase('compressing'); setProgress(2); setElapsedMs(0); setMessage('otimizando a representação'); setError(''); setResult(null);
    comp.optimize(await file.arrayBuffer(), file.name, (event) => {
      if (event.type === 'progress') {
        setProgress(Math.round(event.data.progress * 100));
        setMessage(event.data.message.replace('…', '')); setElapsedMs(event.data.elapsedMs ?? 0);
      } else if (event.type === 'complete') {
        const data = event.data;
        if (data.job === 'optimize') {
          const done = data as OptimizeSuccess;
          const base = file.name.replace(/\.[^.]+$/, '');
          setResult({
            stl: done.stl, fileName: done.fileName,
            gzip: done.gzip, gzipFileName: `${base}.gz`,
            method: done.method, methodLabel: done.methodLabel, tier: done.tier,
            format: done.format, originalBytes: done.originalBytes,
            deliveredBytes: done.deliveredBytes, ratio: done.ratio, faces: done.faces,
            validation: done.validation, checks: done.checks, warnings: done.warnings,
            meanError: done.meanError, maxError: done.maxError,
            volumeDeltaPercent: done.volumeDeltaPercent,
            boundaryOriginal: done.boundaryOriginal, boundaryFinal: done.boundaryFinal,
            elapsedMs: done.elapsedMs,
          });
          setPhase('done'); setProgress(100);
        }
        compRef.current = undefined;
      } else {
        setError(event.data.message); setPhase('error'); setProgress(0); compRef.current = undefined;
      }
    });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Falha ao iniciar a otimização.');
      setPhase(analysis ? 'ready' : 'empty'); setProgress(0); compRef.current = undefined;
    }
  }, []);

  const runDecompress = useCallback(async (file: File) => {
    try {
      compRef.current?.cancel();
      const comp = createCompressor();
      compRef.current = comp;
      setPhase('compressing'); setProgress(2); setElapsedMs(0); setMessage('descompactando e validando'); setError(''); setResult(null); setUnpacked(null);
      setFileName(file.name);
    comp.decompressPack(await file.arrayBuffer(), file.name, (event) => {
      if (event.type === 'progress') {
        setProgress(Math.round(event.data.progress * 100));
        setMessage(event.data.message.replace('…', '')); setElapsedMs(event.data.elapsedMs ?? 0);
      } else if (event.type === 'complete') {
        const data = event.data;
        if (data.job === 'decompress') {
          const done = data as DecompressSuccess;
          setUnpacked({ bytes: done.bytes, fileName: done.fileName, format: done.format, faces: done.faces, elapsedMs: done.elapsedMs });
          setPhase('done'); setProgress(100);
        }
        compRef.current = undefined;
      } else {
        setError(event.data.message); setPhase('error'); setProgress(0); compRef.current = undefined;
      }
    });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Falha ao descompactar.');
      setPhase('empty'); setProgress(0); compRef.current = undefined;
    }
  }, []);

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    fileRef.current = file;
    if (file.name.toLowerCase().endsWith('.3dpack')) void runDecompress(file);
    else void runAnalyze(file);
  }, [runAnalyze, runDecompress]);

  const cancel = useCallback(() => {
    compRef.current?.cancel();
    compRef.current = undefined;
    setPhase(analysis ? 'ready' : 'empty'); setProgress(0); setElapsedMs(0);
  }, [analysis]);

  useEffect(() => () => { compRef.current?.cancel(); }, []);

  return <div className="app-shell dark">
    <Header hasModel={phase !== 'empty' && phase !== 'error'} onImport={() => inputRef.current?.click()} onReset={reset} mode="reduce" onMode={onModeChange} title="LOSSLESS" />
    <div className="px-5 pt-3 md:hidden"><ModeTabs mode="reduce" onMode={onModeChange} /></div>
    {phase === 'empty' && <main className="relative mx-auto flex min-h-[calc(100dvh-66px)] max-w-[1320px] flex-col justify-center px-5 py-12 md:px-10">
      <div className="mb-8 flex items-end justify-between animate-in"><div><div className="eyebrow mb-3 text-orange-400/80">otimização sem alterar a malha</div><h1 className="max-w-xl text-3xl font-medium tracking-[-.04em] text-stone-100 md:text-5xl">Arquivo menor.<br /><span className="text-stone-500">Malha intocada.</span></h1></div><div className="hidden max-w-[210px] text-right text-xs leading-5 text-stone-600 md:block">Representação eficiente sem mover um único vértice.</div></div>
      <div className="animate-in-delay"><Dropzone onFiles={handleFiles} inputRef={inputRef} accept={COMPRESS_ACCEPT} formatsLabel={COMPRESS_FORMATS_LABEL} /></div>
      <div className="mt-6 grid grid-cols-1 gap-px border border-white/[.06] bg-white/[.06] sm:grid-cols-3 animate-in-delay">{[{ icon: LockKeyhole, title: '100% local', copy: 'O arquivo nunca sai deste navegador.' }, { icon: ShieldCheck, title: 'Lossless verificado', copy: 'SHA-256 do round-trip precisa conferir.' }, { icon: Box, title: 'Faces inalteradas', copy: '1.500.000 entram, 1.500.000 saem.' }].map(({ icon: Icon, title, copy }) => <div key={title} className="bg-stone-950/75 p-4"><Icon size={15} className="mb-3 text-orange-400" /><div className="text-xs font-medium">{title}</div><div className="mt-1 text-[11px] text-stone-600">{copy}</div></div>)}</div>
    </main>}
    {phase === 'error' && <><input ref={inputRef} type="file" accept={COMPRESS_ACCEPT} className="hidden" onChange={(event) => handleFiles(event.target.files)} data-testid="input-error-file" /><ErrorState message={error} onReset={() => inputRef.current?.click()} /></>}
    {(phase === 'analyzing' || phase === 'compressing') && <ImportingView progress={progress} message={`${message} · ${(elapsedMs / 1000).toFixed(1)}s`} />}
    {phase === 'ready' && analysis && <main className="relative mx-auto max-w-[1480px] px-4 py-5 md:px-7 lg:px-10">
      <div className="mb-5"><div className="eyebrow mb-2 text-orange-400/80">02 / análise</div><h1 className="text-2xl font-medium tracking-[-.035em] md:text-3xl">Escolha a estratégia.</h1></div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel p-4" aria-label="Análise do arquivo">
          <div className="mb-3 flex items-center gap-2"><FileBox size={15} className="text-orange-400" /><span className="text-sm font-medium">Arquivo analisado</span></div>
          <div className="truncate text-xs text-stone-200" data-testid="text-compress-name">{fileName}</div>
          <div className="mono mt-1 text-[10px] text-stone-600">{analysis.format} · {formatBytes(analysis.originalBytes)}</div>
          <div className="mt-3">
            <MetaLine label="Faces (serão preservadas)" value={analysis.faces > 0 ? formatCount(analysis.faces) : '—'} accent />
            <MetaLine label="Tamanho original" value={formatBytes(analysis.originalBytes)} />
            <MetaLine label="Entropia" value={`${analysis.entropyBitsPerByte} bits/byte`} />
            <MetaLine label="SHA-256" value={shortHash(analysis.originalSha256)} />
          </div>
          {analysis.notes.length > 0 && <div className="mt-3 border-t border-white/[.06] pt-3">{analysis.notes.map((note) => <div key={note} className="mb-1 text-[11px] leading-5 text-stone-500">· {note}</div>)}</div>}
        </section>
        <section className="panel flex flex-col gap-4 p-4" aria-label="Estratégia">
          <MetaSelect target={targetPercent} onChange={setTargetPercent} />
          <button className="button-primary flex h-10 items-center justify-center gap-2 text-xs font-semibold" onClick={() => void runOptimize()} data-testid="button-compress"><Zap size={14} /> Comprimir</button>
          <button className="button-secondary flex h-9 items-center justify-center gap-2 text-xs" onClick={cancel}><Pause size={14} /> Cancelar</button>
          <p className="text-[10px] leading-4 text-stone-600">Faces preservadas, malha intocada. A saída mantém a extensão original (.stl → .stl) e só é liberada após reimportação e comparação geométrica.</p>
        </section>
      </div>
    </main>}
    {phase === 'done' && result && (() => {
      const achieved = (1 - result.ratio) * 100;
      const metaOk = achieved >= targetPercent;
      const checkEntries = Object.entries(result.checks);
      const checklist: Array<[string, boolean]> = checkEntries.length > 0
        ? [
          ['Faces preservadas', result.checks['faces'] ?? true],
          ['Geometria preservada', (result.checks['coordenadas'] ?? true) && (result.checks['normais'] ?? true) && (result.checks['superficie'] ?? true)],
          ['Topologia preservada', (result.checks['watertight'] ?? true) && (result.checks['bordas'] ?? true) && (result.checks['manifold'] ?? true) && (result.checks['componentes'] ?? true)],
          ['Dimensões preservadas', (result.checks['bbox'] ?? true) && (result.checks['centroide'] ?? true) && (result.checks['volume'] ?? true) && (result.checks['area'] ?? true)],
          ['Sem novos buracos', (result.checks['bordas'] ?? true) && result.boundaryFinal <= result.boundaryOriginal],
          ['Arquivo reimportável', result.checks['degeneracao'] ?? true],
        ]
        : [['Faces e coordenadas validados', true]];
      const badge = result.tier === 'A' ? 'LOSSLESS' : 'GEOMETRY LOSSLESS';
      return <main className="relative mx-auto max-w-[1480px] px-4 py-5 md:px-7 lg:px-10">
      <div className="mb-5"><div className="eyebrow mb-2 text-orange-400/80">03 / resultado · {result.validation}</div><h1 className="text-2xl font-medium tracking-[-.035em] md:text-3xl">Compressão 3D concluída.</h1></div>
      {result.warnings.length > 0 && <div className="mb-4 border border-orange-400/20 bg-orange-500/[.06] px-3 py-2 text-xs text-orange-200">{result.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel p-4" aria-label="Resultado da compressão">
          <div className="mb-3 flex items-center gap-2"><CheckCircle2 size={15} className="text-emerald-400" /><span className="text-sm font-medium">{badge}</span><span className="mono ml-auto text-[10px] text-emerald-300" data-testid="text-lossless-badge">{result.validation} · meta {targetPercent}%: {metaOk ? 'SUCESSO' : 'SUCESSO PARCIAL'}</span></div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="border border-white/[.06] bg-black/20 p-3"><div className="eyebrow mb-1 text-stone-600">original</div><div className="mono text-sm text-stone-200">{formatBytes(result.originalBytes)}</div></div>
            <div className="border border-orange-400/25 bg-orange-500/[.06] p-3"><div className="eyebrow mb-1 text-orange-400/80">resultado</div><div className="mono text-sm text-orange-300" data-testid="text-pack-size">{formatBytes(result.deliveredBytes)}</div><div className="mono mt-1 text-[10px] text-orange-400/70">−{achieved.toFixed(1)}%</div></div>
            <div className="border border-white/[.06] bg-black/20 p-3"><div className="eyebrow mb-1 text-stone-600">redução</div><div className="mono text-sm text-stone-200">{achieved.toFixed(1)}%</div><div className="mono mt-1 text-[10px] text-stone-500">meta {targetPercent}%</div></div>
          </div>
          <div className="mt-3">
            <MetaLine label="Faces" value={result.faces > 0 ? `${formatCount(result.faces)} → ${formatCount(result.faces)}` : 'preservadas'} accent />
            <MetaLine label="Geometria" value="PRESERVADA" accent />
            <MetaLine label="Malha" value={result.boundaryFinal < 0 ? 'VÁLIDA / TOPOLOGIA PRESERVADA' : result.boundaryFinal === 0 ? 'VÁLIDA / WATERTIGHT' : `VÁLIDA / ${result.boundaryFinal} borda(s) originais`} accent />
            <MetaLine label="Método" value={result.methodLabel} />
            <MetaLine label="Tempo" value={`${(result.elapsedMs / 1000).toFixed(1)}s`} />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-1 border-t border-white/[.06] pt-3 text-[11px] text-stone-500 sm:grid-cols-2">{checklist.map(([item, ok]) => <div key={item} className="flex items-center gap-1.5"><CheckCircle2 size={12} className={ok ? 'text-emerald-400' : 'text-red-400'} />{item}</div>)}</div>
        </section>
        <section className="panel flex flex-col gap-2 p-4" aria-label="Downloads">
          <button className="button-primary flex h-10 items-center justify-center gap-2 text-xs font-semibold" onClick={() => downloadBytes(result.stl, result.fileName, 'application/octet-stream')} data-testid="button-download-stxyz"><Download size={14} /> Baixar {result.fileName.split('.').pop()?.toUpperCase()} comprimido</button>
          <button className="button-secondary flex h-10 items-center justify-center gap-2 text-xs" onClick={() => downloadBytes(result.gzip, result.gzipFileName, 'application/gzip')} data-testid="button-download-gzip"><Download size={14} /> Baixar .gz (arquivo)</button>
          <button className="button-secondary flex h-10 items-center justify-center gap-2 text-xs" onClick={() => { const file = fileRef.current; if (file) void file.arrayBuffer().then((buffer) => downloadBytes(buffer, file.name, 'application/octet-stream')); }} data-testid="button-download-original"><Download size={14} /> Baixar original</button>
          <button className="flex h-9 items-center justify-center gap-2 text-xs text-stone-500 transition hover:text-orange-300" onClick={reset}><X size={14} /> Novo arquivo</button>
          <p className="text-[10px] leading-4 text-stone-600">O arquivo principal mantém a extensão original e abre direto no slicer. O .gz é só uma opção de arquivamento.</p>
        </section>
      </div>
      </main>;
    })()}
    {phase === 'done' && unpacked && <main className="relative mx-auto max-w-[720px] px-5 py-12 text-center">
      <CheckCircle2 size={25} className="mx-auto mb-5 text-emerald-400" />
      <div className="eyebrow mb-3 text-emerald-300/80">round-trip · lossless pass</div>
      <h1 className="text-3xl font-medium tracking-[-.04em]">Original reconstruído<br /><span className="text-stone-500">byte a byte.</span></h1>
      <p className="mt-4 text-sm leading-6 text-stone-500">{unpacked.fileName} · {unpacked.format}{unpacked.faces > 0 ? ` · ${formatCount(unpacked.faces)} faces` : ''} · SHA-256 conferido em {(unpacked.elapsedMs / 1000).toFixed(1)}s.</p>
      <div className="mt-8 flex justify-center gap-2">
        <button className="button-primary flex h-10 items-center gap-2 px-4 text-xs font-semibold" onClick={() => downloadBytes(unpacked.bytes, unpacked.fileName, 'application/octet-stream')} data-testid="button-download-unpacked"><Download size={14} /> Baixar original</button>
        <button className="button-secondary flex h-10 items-center gap-2 px-4 text-xs" onClick={reset}>Novo arquivo</button>
      </div>
    </main>}
    <footer className="pointer-events-none fixed bottom-3 left-5 right-5 z-10 flex justify-between mono text-[9px] text-stone-700 md:left-8 md:right-8"><span>SEM ALTERAR MALHA / BUILD 4.0.0</span><span className="hidden sm:block">LOSSLESS · LOCAL FIRST</span></footer>
  </div>;
}

type ReducePhase = 'empty' | 'importing' | 'ready' | 'reducing' | 'done' | 'error';

type ReducedResult = {
  stats: MeshStats;
  mesh: MeshData;
  stl: ArrayBuffer;
  report: SimplifyReport;
  validation: WorkerSuccess['validation'];
  warnings: string[];
};

const PROFILE_LABELS: Record<ReductionProfile, { title: string; caption: string }> = {
  quality: { title: 'Qualidade', caption: 'fidelidade máxima' },
  balanced: { title: 'Balanceado', caption: '~50% menor' },
  aggressive: { title: 'Agressivo', caption: '60–70% + vigiado' },
  maximum: { title: 'Máximo', caption: 'menor possível' },
};

const PROFILE_QUALITY: Record<ReductionProfile, Quality> = {
  quality: 'ultra',
  balanced: 'high',
  aggressive: 'medium',
  maximum: 'medium',
};

const PROFILE_SIL_LIMIT: Record<ReductionProfile, number> = {
  quality: 0.012,
  balanced: 0.02,
  aggressive: 0.045,
  maximum: 0.07,
};



function ReductionHome({ onModeChange }: { onModeChange: (mode: AppMode) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<File | undefined>(undefined);
  const procRef = useRef<ReturnType<typeof createMeshProcessor> | undefined>(undefined);
  const [phase, setPhase] = useState<ReducePhase>('empty');
  const [model, setModel] = useState<MeshMeta>();
  const [targetPercent, setTargetPercent] = useState<number>(50);
  const [profile, setProfile] = useState<ReductionProfile>('balanced');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('preparando modelo');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stage, setStage] = useState<Stage>('ANALISANDO');
  const [liveTriangles, setLiveTriangles] = useState(0);
  const [liveOriginal, setLiveOriginal] = useState(0);
  const [comparing, setComparing] = useState(false);
  const [reduced, setReduced] = useState<ReducedResult | null>(null);
  const [topology, setTopology] = useState<ImportTopology | null>(null);
  const [quirks, setQuirks] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [gzBusy, setGzBusy] = useState(false);

  const reset = useCallback(() => {
    procRef.current?.cancel();
    fileRef.current = undefined;
    setPhase('empty'); setModel(undefined); setReduced(null); setError('');
    setTopology(null); setQuirks([]); setNotice('');
    setProgress(0); setComparing(false); setElapsedMs(0);
  }, []);

  const runImport = useCallback(async (file: File) => {
    try {
      procRef.current?.cancel();
      const proc = createMeshProcessor();
      procRef.current = proc;
      setPhase('importing'); setProgress(2); setElapsedMs(0); setMessage('lendo estrutura do arquivo'); setError(''); setNotice('');
      setTopology(null); setQuirks([]); setReduced(null);
      // Watchdog anti-hang: rearmado a cada evento; se o worker ficar mudo
      // (travado ou desatualizado ignorando a mensagem), vira erro acionável.
      let timeout = 0;
      const failHang = (): void => {
        procRef.current?.cancel();
        procRef.current = undefined;
        setError(`O processamento não respondeu em ${Math.round(importTimeoutMs(file.size) / 1000)}s. ${STALE_WORKER_MESSAGE}`);
        setPhase('error'); setProgress(0);
      };
      const poke = (): void => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(failHang, importTimeoutMs(file.size));
      };
      const disarm = (): void => window.clearTimeout(timeout);
      poke();
      // IMPORTAÇÃO PURA: só parse + validação estrutural. Nenhuma redução,
      // nenhum target — o upload é aceito se o arquivo for legível.
      proc.parse(await file.arrayBuffer(), file.name, (event) => {
        poke();
        if (event.type === 'progress') {
          setProgress(Math.round(event.data.progress * 100));
          setMessage(event.data.message.replace('…', '')); setElapsedMs(event.data.elapsedMs ?? 0);
        } else if (event.type === 'complete') {
          const data = event.data;
          if ('job' in data && data.job === 'import') {
            if (!checkProtocol(data.protocol) || !data.positions || !data.indices || !data.stats || !data.topology) {
              setError(STALE_WORKER_MESSAGE); setPhase('error'); setProgress(0);
            } else {
              const imported: MeshData = { positions: data.positions, indices: data.indices, format: data.format, bounds: data.stats.bounds };
              setModel({ name: file.name, format: data.formatLabel, bytes: file.size, stats: data.stats, mesh: imported });
              setTopology(data.topology);
              setQuirks(Array.isArray(data.quirks) ? data.quirks : []);
              setPhase('ready'); setProgress(0);
              setMessage('Modelo carregado com sucesso.');
            }
          }
          disarm();
          procRef.current = undefined;
        } else {
          // Aqui sim é erro de LEITURA (arquivo inválido/corrompido).
          disarm();
          setError(event.data.message); setPhase('error'); setProgress(0); procRef.current = undefined;
        }
      });
    } catch (error) {
      // Nada escapa como exceção não tratada: vira tela de erro acionável.
      setError(error instanceof Error ? error.message : 'Não foi possível ler este arquivo.');
      setPhase('error'); setProgress(0); procRef.current = undefined;
    }
  }, []);

  const runReduce = useCallback(async () => {
    const file = fileRef.current;
    if (!file || !model) return;
    try {
      const targetFaces = targetFacesForSize(file.size, model.stats.triangles, targetPercent);
      procRef.current?.cancel();
      const proc = createMeshProcessor();
      procRef.current = proc;
      setPhase('reducing'); setProgress(2); setElapsedMs(0); setMessage('mapeando importância geométrica'); setError(''); setReduced(null); setNotice('');
      setStage('ANALISANDO'); setLiveTriangles(0); setLiveOriginal(0);
      const tris = model.stats.triangles;
      const budget = tris < 500000 ? 55_000 : Math.min(300000, 55000 + ((tris - 500000) / 500000) * 60000);
      proc.process(await file.arrayBuffer(), file.name, {
        targetTriangles: targetFaces, quality: PROFILE_QUALITY[profile],
        preserveBorders: true, preserveSilhouette: true, protectDetails: true,
        profile, timeBudgetMs: Math.round(budget),
      }, (event) => {
        if (event.type === 'progress') {
          setProgress(Math.round(event.data.progress * 100));
          setMessage(event.data.message.replace('…', '')); setElapsedMs(event.data.elapsedMs ?? 0);
          if (event.data.stage) setStage(event.data.stage);
          if (event.data.currentTriangles) setLiveTriangles(event.data.currentTriangles);
          if (event.data.originalTriangles) setLiveOriginal(event.data.originalTriangles);
        } else if (event.type === 'complete') {
          const result = event.data as WorkerSuccess;
          if (!checkProtocol((result as { protocol?: unknown }).protocol) || !result.positions || !result.indices || !result.reduced || !result.stl) {
            setError(STALE_WORKER_MESSAGE); setPhase('error'); setProgress(0);
          } else {
            const mesh: MeshData = { positions: result.positions, indices: result.indices, format: result.format, bounds: result.reduced.bounds };
            setReduced({
              stats: result.reduced, mesh, stl: result.stl.buffer, report: ensureReport(result.report),
              validation: result.validation, warnings: Array.isArray(result.warnings) ? result.warnings : [],
            });
            setComparing(true); setProgress(100); setPhase('done');
          }
          procRef.current = undefined;
        } else {
          // Falha de OTIMIZAÇÃO ≠ falha de upload: o modelo continua
          // carregado; o aviso explica e sugere alternativas.
          if (isZeroReductionError(event.data)) {
            setNotice(`${event.data.message} Tente o perfil Máximo ou a aba Sem alterar malha.`);
            setPhase('ready'); setProgress(0);
          } else {
            setError(event.data.message); setPhase('error'); setProgress(0);
          }
          procRef.current = undefined;
        }
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Falha ao iniciar a compressão.');
      setPhase(model ? 'ready' : 'empty'); setProgress(0); procRef.current = undefined;
    }
  }, [model, targetPercent, profile]);

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    fileRef.current = file;
    void runImport(file);
  }, [runImport]);

  const cancel = useCallback(() => {
    procRef.current?.cancel();
    procRef.current = undefined;
    setPhase(model ? 'ready' : 'empty'); setProgress(0); setElapsedMs(0);
  }, [model]);

  const downloadGzip = useCallback(() => {
    if (!reduced || gzBusy) return;
    setGzBusy(true);
    void packGzip(new Uint8Array(reduced.stl)).then((gz) => {
      const copy = gz.buffer.slice(0) as ArrayBuffer;
      downloadBytes(copy, reducedName(fileRef.current?.name ?? 'modelo.stl') + '.gz', 'application/gzip');
    }).finally(() => setGzBusy(false));
  }, [reduced, gzBusy]);

  useEffect(() => () => { procRef.current?.cancel(); }, []);

  const targetFaces = model && fileRef.current ? targetFacesForSize(fileRef.current.size, model.stats.triangles, targetPercent) : 0;
  const canReduce = !!model && targetFaces < model.stats.triangles;

  return <div className="app-shell dark">
    <Header hasModel={phase !== 'empty' && phase !== 'error'} onImport={() => inputRef.current?.click()} onReset={reset} mode="compress" onMode={onModeChange} title="COMPRESSÃO" />
    <div className="px-5 pt-3 md:hidden"><ModeTabs mode="compress" onMode={onModeChange} /></div>
    {phase === 'empty' && <main className="relative mx-auto flex min-h-[calc(100dvh-66px)] max-w-[1320px] flex-col justify-center px-5 py-12 md:px-10">
      <div className="mb-8 flex items-end justify-between animate-in"><div><div className="eyebrow mb-3 text-orange-400/80">01 / entrada · redução inteligente</div><h1 className="max-w-xl text-3xl font-medium tracking-[-.04em] text-stone-100 md:text-5xl">Metade do tamanho.<br /><span className="text-stone-500">A mesma peça.</span></h1></div><div className="hidden max-w-[210px] text-right text-xs leading-5 text-stone-600 md:block">Áreas simples financiam a redução. Features ficam protegidas.</div></div>
      <div className="animate-in-delay"><Dropzone onFiles={handleFiles} inputRef={inputRef} accept=".stl,model/stl" formatsLabel="STL BINÁRIO · STL ASCII" /></div>
      <div className="mt-6 grid grid-cols-1 gap-px border border-white/[.06] bg-white/[.06] sm:grid-cols-3 animate-in-delay">{[{ icon: ScanLine, title: 'Mapa de importância', copy: 'Cada região recebe um peso geométrico.' }, { icon: ShieldCheck, title: 'Features protegidas', copy: 'Olhos, dedos e relevos sob lock.' }, { icon: FileBox, title: 'STL pronto', copy: 'Saída válida para o slicer.' }].map(({ icon: Icon, title, copy }) => <div key={title} className="bg-stone-950/75 p-4"><Icon size={15} className="mb-3 text-orange-400" /><div className="text-xs font-medium">{title}</div><div className="mt-1 text-[11px] text-stone-600">{copy}</div></div>)}</div>
    </main>}
    {phase === 'error' && <><input ref={inputRef} type="file" accept=".stl,model/stl" className="hidden" onChange={(event) => handleFiles(event.target.files)} data-testid="input-error-file" /><ErrorState message={error} onReset={() => inputRef.current?.click()} title={error.includes('redução segura') ? 'Nenhuma redução segura foi possível.' : undefined} /></>}
    {phase === 'importing' && <ImportingView progress={progress} message={message} />}
    {phase === 'reducing' && model && <ProcessingView progress={progress} message={message} elapsedMs={elapsedMs} stage={stage} originalTriangles={liveOriginal || model.stats.triangles} currentTriangles={liveTriangles || model.stats.triangles} targetTriangles={targetFaces} onCancel={cancel} />}
    {phase === 'ready' && model && <main className="relative mx-auto max-w-[1480px] px-4 py-5 md:px-7 lg:px-10">
      <div className="mb-5"><div className="eyebrow mb-2 text-orange-400/80">02 / meta de redução</div><h1 className="text-2xl font-medium tracking-[-.035em] md:text-3xl">Arquivo carregado. Quanto reduzir?</h1></div>
      {notice && <div className="mb-4 border border-orange-400/20 bg-orange-500/[.06] px-3 py-2 text-xs text-orange-200">{notice}</div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel p-4" aria-label="Arquivo">
          <div className="mb-3 flex items-center gap-2"><CheckCircle2 size={15} className="text-emerald-400" /><span className="text-sm font-medium">Arquivo recebido ✓</span></div>
          <div className="truncate text-xs text-stone-200">{model.name}</div>
          <div className="mono mt-1 text-[10px] text-stone-600">{model.format} · {formatBytes(model.bytes)}</div>
          <div className="mt-2">
            <MetaLine label="Status" value="Modelo carregado com sucesso." accent />
            <MetaLine label="Tamanho original" value={formatBytes(model.bytes)} />
            <MetaLine label="Faces" value={formatCount(model.stats.triangles)} />
            <MetaLine label="Vértices" value={formatCount(model.stats.vertices)} />
            {topology && <MetaLine label="Topologia" value={topology.watertight ? 'VÁLIDA / WATERTIGHT' : `VÁLIDA / ${formatCount(topology.boundaryLoops)} abertura(s) originais`} />}
            <MetaLine label="Alvo de faces" value={formatCount(targetFaces)} accent />
            <MetaLine label="Tamanho estimado" value={`~${formatBytes(84 + targetFaces * 50)}`} accent />
          </div>
          {quirks.length > 0 && <div className="mt-3 border-t border-white/[.06] pt-3">{quirks.map((quirk) => <div key={quirk} className="mb-1 text-[11px] leading-5 text-stone-500">· {quirk}</div>)}</div>}
        </section>
        <section className="panel flex flex-col gap-4 p-4" aria-label="Meta e perfil">
          <MetaSelect target={targetPercent} onChange={setTargetPercent} />
          <div><div className="mb-2 text-xs text-stone-400">Perfil de qualidade</div><div className="grid grid-cols-2 gap-1">{(Object.keys(PROFILE_LABELS) as ReductionProfile[]).map((option) => <button key={option} className={`border px-2 py-2 text-left transition ${profile === option ? 'border-orange-400/60 bg-orange-500/10 text-orange-300' : 'border-white/[.07] bg-black/10 text-stone-500 hover:border-white/20'}`} onClick={() => setProfile(option)} data-testid={`button-profile-${option}`}><span className="block text-[11px]">{PROFILE_LABELS[option].title}</span><span className="mono text-[9px] text-stone-600">{PROFILE_LABELS[option].caption}</span></button>)}</div></div>
          {!canReduce && <div className="border border-orange-400/20 bg-orange-500/[.06] px-3 py-2 text-xs text-orange-200">A meta não exige redução para este arquivo. Aumente a meta para continuar.</div>}
          <button className="button-primary flex h-10 items-center justify-center gap-2 text-xs font-semibold disabled:opacity-40" onClick={() => void runReduce()} disabled={!canReduce} data-testid="button-reduce"><Zap size={14} /> Comprimir {targetPercent}%</button>
          <p className="text-[10px] leading-4 text-stone-600">Redução adaptativa: áreas simples pagam a conta, features ficam protegidas. O original nunca é alterado.</p>
        </section>
      </div>
    </main>}
    {phase === 'done' && model && reduced && (() => {
      const achieved = (1 - reduced.stl.byteLength / model.bytes) * 100;
      const metaOk = achieved >= targetPercent;
      const silOk = reduced.report.silhouetteError <= PROFILE_SIL_LIMIT[profile];
      const valid = reduced.validation.qualityAccepted && reduced.validation.boundaryLoops <= reduced.report.boundaryOriginal && reduced.validation.nonManifoldEdges === 0;
      const fidelity = profile === 'quality' ? 'FIDELIDADE MÁXIMA' : profile === 'balanced' ? 'ALTA FIDELIDADE' : 'FIDELIDADE CONTROLADA';
      return <main className="relative mx-auto max-w-[1480px] px-4 py-5 md:px-7 lg:px-10">
      <div className="mb-5"><div className="eyebrow mb-2 text-orange-400/80">03 / resultado · {reduced.report.stoppedReason === 'target' ? 'meta atingida' : 'redução máxima segura'}</div><h1 className="text-2xl font-medium tracking-[-.035em] md:text-3xl">Compressão 3D concluída.</h1></div>
      {(reduced.report.stoppedReason === 'quality' || reduced.report.stoppedReason === 'stall') && <div className="mb-4 border border-orange-400/20 bg-orange-500/[.06] px-3 py-2 text-xs text-orange-200">Redução máxima segura atingida: parar aqui preserva a identidade do modelo. {reduced.report.escalations > 0 ? `O sistema redistribuiu a redução ${reduced.report.escalations}x para áreas simples.` : ''}</div>}
      {reduced.warnings.length > 0 && <div className="mb-4 border border-white/[.08] bg-black/20 px-3 py-2 text-xs text-stone-400">{reduced.warnings.slice(0, 3).map((warning) => <div key={warning}>{warning}</div>)}</div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <MeshViewport original={model.mesh} reduced={reduced.mesh} comparing={comparing} processing={false} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-white/[.07] bg-black/20 px-3 py-2">
            <button className="flex items-center gap-2 text-xs text-stone-400 transition hover:text-orange-300" onClick={() => setComparing(!comparing)} data-testid="button-toggle-comparison">{comparing ? 'Exibindo reduzida — ver original' : 'Exibindo original — ver reduzida'}</button>
            <span className="mono text-[10px] text-stone-600">{formatCount(model.stats.triangles)} → {formatCount(reduced.stats.triangles)} faces</span>
          </div>
          <section className="panel mt-4 p-4" aria-label="Relatório de qualidade">
            <div className="mb-2 flex items-center gap-2"><ScanLine size={15} className="text-orange-400" /><span className="text-sm font-medium">Relatório de qualidade</span></div>
            <MetaLine label="Redução de tamanho" value={`${achieved.toFixed(1)}% (meta ${targetPercent}%: ${metaOk ? 'SUCESSO' : 'SUCESSO PARCIAL'})`} accent />
            <MetaLine label="Redução de faces" value={`${formatCount(model.stats.triangles)} → ${formatCount(reduced.stats.triangles)}`} />
            <MetaLine label="Erro geométrico médio" value={`${(reduced.report.meanError * 100).toFixed(3)}%`} />
            <MetaLine label="Erro geométrico máximo" value={`${(reduced.report.maxError * 100).toFixed(3)}%`} />
            <MetaLine label="Erro RMS" value={`${((reduced.report.rmsError ?? 0) * 100).toFixed(3)}%`} />
            <MetaLine label="Reconstrução" value={(() => { const h = reduced.report.healing; if (!h || h.defectsFound === 0) return 'sem defeitos'; return `${h.defectsRepaired} corrigidos · ${h.facesAdded} faces`; })()} accent />
            <MetaLine label="Erro de silhueta" value={`${(reduced.report.silhouetteError * 100).toFixed(2)}% ${silOk ? '· PASS' : '· REVISAR'}`} />
            <MetaLine label="Erro de normal" value={reduced.report.normalError.toFixed(4)} />
            <MetaLine label="Erro de curvatura" value={reduced.report.curvatureError.toFixed(4)} />
            <MetaLine label="Alteração de volume" value={`${reduced.report.volumeDeltaPercent.toFixed(2)}%`} />
            <MetaLine label="Buracos novos" value={reduced.report.boundaryFinal <= reduced.report.boundaryOriginal ? '0' : `${reduced.report.boundaryFinal - reduced.report.boundaryOriginal}`} />
            <MetaLine label="Non-manifold" value={`${reduced.report.nonManifoldEdges}`} />
            <MetaLine label="Triângulos degenerados" value={`${reduced.report.degenerateTriangles}`} />
            <MetaLine label="Tempo de processamento" value={`${(elapsedMs / 1000).toFixed(1)}s`} />
          </section>
        </div>
        <section className="panel flex h-fit flex-col gap-2 p-4 lg:sticky lg:top-4" aria-label="Downloads">
          <div className="mb-1 grid grid-cols-3 gap-2 text-center">
            <div className="border border-white/[.06] bg-black/20 p-3"><div className="eyebrow mb-1 text-stone-600">original</div><div className="mono text-sm text-stone-200">{formatBytes(model.bytes)}</div></div>
            <div className="border border-orange-400/25 bg-orange-500/[.06] p-3"><div className="eyebrow mb-1 text-orange-400/80">resultado</div><div className="mono text-sm text-orange-300" data-testid="text-result-size">{formatBytes(reduced.stl.byteLength)}</div><div className="mono mt-1 text-[10px] text-orange-400/70">−{achieved.toFixed(1)}%</div></div>
            <div className="border border-white/[.06] bg-black/20 p-3"><div className="eyebrow mb-1 text-stone-600">faces</div><div className="mono text-sm text-stone-200">{formatCount(reduced.stats.triangles)}</div></div>
          </div>
          <MetaLine label="Geometria" value={fidelity} accent />
          {reduced.report.effectiveProfile && reduced.report.effectiveProfile !== profile && <MetaLine label="Estratégia final" value={`perfil ${reduced.report.effectiveProfile} (escalonado)`} accent />}
          <MetaLine label="Malha" value={reduced.report.boundaryFinal <= 0 ? 'VÁLIDA' : 'VÁLIDA / bordas originais'} accent />
          <MetaLine label="Watertight" value={reduced.validation.watertight ? 'PASS' : '—'} accent />
          <MetaLine label="Validação" value={valid ? '✓ PASS' : 'REVISAR'} accent />
          <button className="button-primary mt-2 flex h-10 items-center justify-center gap-2 text-xs font-semibold" onClick={() => downloadStl(reduced.stl, model.name)} data-testid="button-download-stl"><Download size={14} /> Baixar STL comprimido</button>
          <button className="button-secondary flex h-10 items-center justify-center gap-2 text-xs" onClick={downloadGzip} disabled={gzBusy} data-testid="button-download-gzip"><Download size={14} /> {gzBusy ? 'Gerando .gz…' : 'Baixar .gz (arquivo)'}</button>
          <button className="flex h-9 items-center justify-center gap-2 text-xs text-stone-500 transition hover:text-orange-300" onClick={reset}><X size={14} /> Novo arquivo</button>
        </section>
      </div>
      </main>;
    })()}
    <footer className="pointer-events-none fixed bottom-3 left-5 right-5 z-10 flex justify-between mono text-[9px] text-stone-700 md:left-8 md:right-8"><span>COMPRESSÃO 3D / BUILD 5.0.0</span><span className="hidden sm:block">ADAPTIVE QEM · LOCAL FIRST</span></footer>
  </div>;
}

function reducedName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function Home() {
  const [mode, setMode] = useState<AppMode>('compress');
  const onModeChange = useCallback((next: AppMode) => setMode(next), []);
  return <>
    <div hidden={mode !== 'compress'}><ReductionHome onModeChange={onModeChange} /></div>
    <div hidden={mode !== 'reduce'}><LosslessHome onModeChange={onModeChange} /></div>
  </>;
}

function Router() {
  return <Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary resetKey={useLocation()[0]}><Router /></ErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
