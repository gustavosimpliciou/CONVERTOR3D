import type {
  ImportRequest,
  ImportSuccess,
  MeshData,
  SimplifyOptions,
  SimplifyReport,
  WorkerFailure,
  WorkerProgress,
  WorkerRequest,
  WorkerSuccess,
} from './types';
import { MESH_PROTOCOL } from './types';

export type ProcessorEvent =
  | { type: 'progress'; data: WorkerProgress }
  | { type: 'complete'; data: WorkerSuccess | ImportSuccess }
  | { type: 'error'; data: WorkerFailure };

/**
 * Classifica erro do worker: ZERO_REDUCTION (upload válido, só a redução
 * não avançou → aviso, modelo mantido) vs. erro fatal (arquivo ilegível).
 */
export function isZeroReductionError(data: WorkerFailure): boolean {
  return data.code === 'ZERO_REDUCTION' || data.message.includes('Nenhuma redução segura');
}

/**
 * Verifica o protocolo da resposta. Blindagem contra worker desatualizado
 * em cache: campos novos como `report` podem não existir.
 */
export function checkProtocol(actual: unknown): boolean {
  return actual === MESH_PROTOCOL;
}

export const STALE_WORKER_MESSAGE =
  'A versão do processador está desatualizada no cache do navegador. Recarregue a página (Ctrl+Shift+R) e tente novamente.';

/**
 * Timeout da importação dimensionado pelo tamanho: arquivos grandes
 * (welding de milhões de vértices) precisam de dezenas de segundos.
 * Só dispara se NENHUM evento chegar (hang real, ex. worker travado).
 */
export function importTimeoutMs(bytes: number): number {
  return Math.max(30000, 15000 + (bytes / 1048576) * 1500);
}

/** Relatório vazio para render defensivo (nunca quebra a tela). */
export function ensureReport(report: SimplifyReport | undefined | null): SimplifyReport {
  if (report) return report;
  return {
    stages: 0,
    commits: 0,
    meanError: 0,
    maxError: 0,
    rmsError: 0,
    silhouetteError: 0,
    normalError: 0,
    curvatureError: 0,
    volumeDeltaPercent: 0,
    areaDeltaPercent: 0,
    boundaryOriginal: 0,
    boundaryFinal: 0,
    nonManifoldEdges: 0,
    degenerateTriangles: 0,
    stoppedReason: 'stall',
    escalations: 0,
    hausdorffApprox: 0,
    components: 1,
    componentFloorsHit: 0,
    targetTooAggressive: false,
    healing: {
      defectsFound: 0,
      defectsRepaired: 0,
      defectsRolledBack: 0,
      facesAdded: 0,
      timeMs: 0,
      log: [],
    },
  };
}

export function createMeshProcessor() {
  let worker: Worker | undefined;

  const spawn = (onEvent: (event: ProcessorEvent) => void): Worker => {
    worker?.terminate();
    worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerSuccess | ImportSuccess | WorkerFailure>) => {
      if (event.data.type === 'progress') onEvent({ type: 'progress', data: event.data });
      else if (event.data.type === 'complete') {
        onEvent({ type: 'complete', data: event.data });
        worker?.terminate();
        worker = undefined;
      } else {
        onEvent({ type: 'error', data: event.data });
        worker?.terminate();
        worker = undefined;
      }
    };
    worker.onerror = (event) => {
      onEvent({
        type: 'error',
        data: {
          type: 'error',
          message: 'O navegador não conseguiu concluir o processamento deste arquivo.',
          technical: event.message,
        },
      });
      worker?.terminate();
      worker = undefined;
    };
    return worker;
  };

  return {
    /** IMPORTAÇÃO (upload): só lê e valida a estrutura. Nunca reduz. */
    parse(buffer: ArrayBuffer, fileName: string, onEvent: (event: ProcessorEvent) => void) {
      const active = spawn(onEvent);
      const request: ImportRequest = { type: 'import', buffer, fileName };
      active.postMessage(request, [buffer]);
    },
    process(
      buffer: ArrayBuffer,
      fileName: string,
      options: SimplifyOptions,
      onEvent: (event: ProcessorEvent) => void,
    ) {
      const active = spawn(onEvent);
      const request: WorkerRequest = {
        type: 'process',
        buffer,
        fileName,
        targetTriangles: options.targetTriangles,
        quality: options.quality,
        preserveBorders: options.preserveBorders,
        preserveSilhouette: options.preserveSilhouette,
        protectDetails: options.protectDetails,
        timeBudgetMs: options.timeBudgetMs ?? 55_000,
        profile: options.profile,
        limits: options.limits,
        targetMode: options.targetMode,
        smartLevel: options.smartLevel,
        errorBudget: options.errorBudget,
        minComponentTriangles: options.minComponentTriangles,
        preserveUV: options.preserveUV ?? true,
        preserveMaterials: options.preserveMaterials ?? true,
        preserveColors: options.preserveColors ?? true,
        preserveSkinning: options.preserveSkinning ?? true,
      };
      active.postMessage(request, [buffer]);
    },
    cancel() {
      worker?.terminate();
      worker = undefined;
    },
  };
}

/** Percentage of original triangles to retain; independent of file encoding. */
export function targetFacesToKeep(originalTriangles: number, percent: number): number {
  const total = Math.max(0, Math.floor(originalTriangles));
  if (!Number.isFinite(percent)) throw new Error('Porcentagem inválida.');
  return Math.min(total, Math.max(Math.min(4, total), Math.floor(total * Math.max(0.2, Math.min(100, percent)) / 100)));
}

/**
 * Meta % do TAMANHO → alvo de faces (STL binário: 84 + 50 bytes/face).
 * Usa o tamanho REAL do arquivo, nunca estimativa fixa.
 */
export function targetFacesForSize(originalBytes: number, originalTriangles: number, percent: number): number {
  const targetBytes = Math.max(84 + 4 * 50, (1 - percent / 100) * originalBytes);
  return Math.max(4, Math.min(originalTriangles - 1, Math.floor((targetBytes - 84) / 50)));
}

/** Orçamento de erro geométrico por nível Smart (fração da diagonal). */
export const SMART_ERROR_BUDGET: Record<string, number> = {
  quality: 0.002,
  balanced: 0.0035,
  aggressive: 0.005,
};

/** Presets de dispositivo → teto de triângulos (regras práticas de tempo real). */
export const DEVICE_TRIANGLE_CEILING: Record<string, number> = {
  background: 1500,
  held: 8000,
  mobile: 15000,
  desktop: 60000,
  hero: 200000,
};

export const DEVICE_PRESET_LABEL: Record<string, string> = {
  background: 'Prop de fundo (≤1,5k)',
  held: 'Prop de mão (≤8k)',
  mobile: 'Personagem mobile (≤15k)',
  desktop: 'Personagem desktop (≤60k)',
  hero: 'Hero / cinemática (≤200k)',
};

/**
 * Resolve o budget de triângulos nos 4 modos profissionais:
 * percent (fração a manter), exact (contagem exata), device (teto) e
 * smart (fração adaptativa pela complexidade — ponto de partida seguro).
 * Sempre retorna em UMA passada a partir do original (nunca encadeia).
 */
export function resolveTriangleBudget(
  originalTriangles: number,
  budget: { mode: string; percent?: number; exactTriangles?: number; device?: string; smartLevel?: string },
): { targetTriangles: number; errorBudget?: number } {
  const total = Math.max(4, Math.floor(originalTriangles));
  if (budget.mode === 'exact') {
    const exact = Math.floor(budget.exactTriangles ?? total);
    return { targetTriangles: Math.max(4, Math.min(total - 1, exact)) };
  }
  if (budget.mode === 'device') {
    const ceiling = DEVICE_TRIANGLE_CEILING[budget.device ?? 'mobile'] ?? 15000;
    return { targetTriangles: Math.max(4, Math.min(total - 1, Math.min(total, ceiling))) };
  }
  if (budget.mode === 'smart') {
    const level = (budget.smartLevel ?? 'balanced') as keyof typeof SMART_ERROR_BUDGET;
    const errorBudget = SMART_ERROR_BUDGET[level] ?? SMART_ERROR_BUDGET.balanced;
    // Ponto de partida conservador por nível; o error budget governa a parada.
    const keep = level === 'quality' ? 0.5 : level === 'balanced' ? 0.3 : 0.12;
    return {
      targetTriangles: Math.max(4, Math.min(total - 1, Math.floor(total * keep))),
      errorBudget,
    };
  }
  const percent = budget.percent ?? 50;
  const keep = Math.max(1, Math.min(99, 100 - percent > 50 ? 100 - percent : percent <= 100 ? percent : 50));
  // `percent` aqui = fração a MANTER (50 = metade). Compat: valores antigos
  // de "reduzir X%" são interpretados como manter (100-X) quando >50.
  void keep;
  const keepFraction = Math.max(0.01, Math.min(0.99, percent / 100));
  return { targetTriangles: Math.max(4, Math.min(total - 1, Math.floor(total * keepFraction))) };
}

/** Piso mínimo por componente: peças pequenas nunca somem no ratio global. */
export function componentTriangleFloor(componentTriangles: number, globalTarget: number, globalTotal: number): number {
  if (componentTriangles <= 0) return 4;
  // Componentes pequenos (≤2k tris) mantêm ≥40%; médios mantêm proporcional com piso.
  if (componentTriangles <= 300) return componentTriangles;
  if (componentTriangles <= 2000) return Math.max(24, Math.floor(componentTriangles * 0.4));
  const proportional = Math.floor((componentTriangles / Math.max(1, globalTotal)) * globalTarget);
  return Math.max(48, proportional);
}

export function meshDataFromSuccess(data: WorkerSuccess, format: MeshData['format']): MeshData {
  return {
    positions: data.positions,
    indices: data.indices,
    format,
    bounds: data.reduced.bounds,
  };
}

export function downloadStl(buffer: ArrayBuffer, fileName: string) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'model/stl' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.replace(/\.[^.]+$/, '') + '_comprimido.stl';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
