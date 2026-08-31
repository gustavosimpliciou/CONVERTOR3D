import type {
  MeshData,
  SimplifyOptions,
  WorkerFailure,
  WorkerProgress,
  WorkerRequest,
  WorkerSuccess,
  PipelineOptions,
  PipelineResult
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

export async function processMeshInMainThread(
  buffer: ArrayBuffer,
  fileName: string,
  options: any,
  onProgress?: (phase: string, progress: number, message: string) => void
): Promise<any> {
  const { processMeshPipeline } = await import('./mesh-pipeline');
  const { parseMesh } = await import('./parser');
  
  const mesh = parseMesh(buffer, fileName);
  return processMeshPipeline(mesh, {
    targetTriangles: options.targetTriangles,
    quality: options.quality,
    preserveBorders: options.preserveBorders,
    preserveSilhouette: options.preserveSilhouette,
    protectDetails: options.protectDetails,
    preserveVolume: options.preserveVolume || true,
    maxError: options.maxError || 0.01,
    maxAspectRatio: options.maxAspectRatio || 50,
    minTriangleArea: options.minTriangleArea || 1e-12,
    smoothIterations: options.smoothIterations || 3,
    reprojectToOriginal: options.reprojectToOriginal !== false,
    onProgress
  });
}

export function createMeshProcessorWithFallback() {
  let worker: Worker | undefined;
  let useMainThread = false;

  return {
    async process(
      buffer: ArrayBuffer,
      fileName: string,
      options: any,
      onEvent: (event: any) => void,
    ) {
      if (useMainThread) {
        try {
          const result = await processMeshInMainThread(buffer, fileName, options, (phase, progress, message) => {
            onEvent({ type: 'progress', data: { type: 'progress', phase, progress, message } });
          });
          onEvent({ type: 'complete', data: result });
          return;
        } catch (error) {
          onEvent({
            type: 'error',
            data: {
              type: 'error',
              message: error instanceof Error ? error.message : 'Erro no processamento',
              technical: error instanceof Error ? error.stack : String(error),
            },
          });
          return;
        }
      }

      worker?.terminate();
      worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<any>) => {
        if (event.data.type === 'progress') onEvent({ type: 'progress', data: event.data });
        else if (event.data.type === 'complete') {
          onEvent({ type: 'complete', data: event.data });
          worker?.terminate();
          worker = undefined;
        } else if (event.data.type === 'error') {
          // Fallback to main thread on worker error
          useMainThread = true;
          worker?.terminate();
          worker = undefined;
          this.process(buffer, fileName, options, onEvent);
        } else {
          onEvent({ type: 'error', data: event.data });
          worker?.terminate();
          worker = undefined;
        }
      };
      worker.onerror = (event) => {
        useMainThread = true;
        worker?.terminate();
        worker = undefined;
        this.process(buffer, fileName, options, onEvent);
      };
      const request: any = {
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

export function meshDataFromSuccess(data: any, format: string): any {
  return {
    positions: data.positions,
    indices: data.indices,
    format,
    bounds: data.reduced?.bounds || { min: [0,0,0], max: [0,0,0], size: [0,0,0] },
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