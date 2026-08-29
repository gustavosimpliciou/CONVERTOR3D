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
  let progressHistory: WorkerProgress[] = [];

  return {
    process(
      buffer: ArrayBuffer,
      fileName: string,
      options: SimplifyOptions,
      onEvent: (event: ProcessorEvent) => void,
    ) {
      progressHistory = [];
      worker?.terminate();
      worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerSuccess | WorkerFailure>) => {
        if (event.data.type === 'progress') {
          progressHistory.push(event.data);
          onEvent({ type: 'progress', data: event.data });
        }
        else if (event.data.type === 'complete') {
          onEvent({ type: 'complete', data: event.data });
          worker?.terminate();
          worker = undefined;
        }
        else {
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

    getProgressHistory() {
      return progressHistory;
    }
  };
}