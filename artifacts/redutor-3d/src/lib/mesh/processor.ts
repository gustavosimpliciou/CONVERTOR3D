import type {
  MeshData,
  SimplifyOptions,
  WorkerFailure,
  WorkerProgress,
  WorkerRequest,
  WorkerSuccess,
} from './types';

export type ProcessorEvent =
  | { type: 'progress'; data: WorkerProgress }
  | { type: 'complete'; data: WorkerSuccess }
  | { type: 'error'; data: WorkerFailure };

export function createMeshProcessor() {
  let worker: Worker | undefined;

  return {
    process(
      buffer: ArrayBuffer,
      fileName: string,
      options: SimplifyOptions,
      onEvent: (event: ProcessorEvent) => void,
    ) {
      worker?.terminate();
      worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerSuccess | WorkerFailure>) => {
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
      const request: WorkerRequest = {
        type: 'process',
        buffer,
        fileName,
        targetTriangles: options.targetTriangles,
        quality: options.quality,
        preserveBorders: options.preserveBorders,
        preserveSilhouette: options.preserveSilhouette,
        protectDetails: options.protectDetails,
        distributeFacesProportionally: options.distributeFacesProportionally,
      };
      worker.postMessage(request, [buffer]);
    },
    cancel() {
      worker?.terminate();
      worker = undefined;
    },
  };
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
  anchor.download = fileName.replace(/\.[^.]+$/, '') + '_reduzido.stl';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}