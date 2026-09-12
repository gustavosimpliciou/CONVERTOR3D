import type {
  ImportRequest,
  ImportSuccess,
  MeshData,
  SimplifyOptions,
  WorkerFailure,
  WorkerProgress,
  WorkerRequest,
  WorkerSuccess,
} from './types';

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
      };
      active.postMessage(request, [buffer]);
    },
    cancel() {
      worker?.terminate();
      worker = undefined;
    },
  };
}

/**
 * Meta % do TAMANHO → alvo de faces (STL binário: 84 + 50 bytes/face).
 * Usa o tamanho REAL do arquivo, nunca estimativa fixa.
 */
export function targetFacesForSize(originalBytes: number, originalTriangles: number, percent: number): number {
  const targetBytes = Math.max(84 + 4 * 50, (1 - percent / 100) * originalBytes);
  return Math.max(4, Math.min(originalTriangles - 1, Math.floor((targetBytes - 84) / 50)));
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
