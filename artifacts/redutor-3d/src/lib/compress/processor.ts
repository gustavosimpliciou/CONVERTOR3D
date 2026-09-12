/**
 * createCompressor — ponte UI ↔ compressor.worker.ts (MODO 1).
 * Espelha a API do createMeshProcessor para consistência.
 */
import type {
  AnalyzeSuccess,
  CompressLevel,
  CompressorFailure,
  CompressorProgress,
  CompressorSuccess,
  DecompressSuccess,
} from '../mesh/types';

export type CompressorEvent =
  | { type: 'progress'; data: CompressorProgress }
  | { type: 'complete'; data: CompressorSuccess | DecompressSuccess | AnalyzeSuccess }
  | { type: 'error'; data: CompressorFailure };

export function createCompressor() {
  let worker: Worker | undefined;

  const terminate = (): void => {
    worker?.terminate();
    worker = undefined;
  };

  const attach = (onEvent: (event: CompressorEvent) => void): void => {
    if (!worker) return;
    worker.onmessage = (event: MessageEvent<CompressorProgress | CompressorSuccess | DecompressSuccess | CompressorFailure>) => {
      if (event.data.type === 'progress') onEvent({ type: 'progress', data: event.data });
      else if (event.data.type === 'complete') {
        onEvent({ type: 'complete', data: event.data });
        terminate();
      } else {
        onEvent({ type: 'error', data: event.data });
        terminate();
      }
    };
    worker.onerror = (event) => {
      onEvent({
        type: 'error',
        data: { type: 'error', job: 'compress', message: 'O navegador não conseguiu concluir a compressão.', technical: event.message },
      });
      terminate();
    };
  };

  return {
    analyze(buffer: ArrayBuffer, fileName: string, onEvent: (event: CompressorEvent) => void) {
      terminate();
      worker = new Worker(new URL('./compressor.worker.ts', import.meta.url), { type: 'module' });
      attach(onEvent);
      worker.postMessage({ type: 'analyze', buffer, fileName }, [buffer]);
    },
    compress(buffer: ArrayBuffer, fileName: string, level: CompressLevel, onEvent: (event: CompressorEvent) => void) {
      terminate();
      worker = new Worker(new URL('./compressor.worker.ts', import.meta.url), { type: 'module' });
      attach(onEvent);
      worker.postMessage({ type: 'compress', buffer, fileName, level }, [buffer]);
    },
    decompressPack(buffer: ArrayBuffer, fileName: string, onEvent: (event: CompressorEvent) => void) {
      terminate();
      worker = new Worker(new URL('./compressor.worker.ts', import.meta.url), { type: 'module' });
      attach(onEvent);
      worker.postMessage({ type: 'decompress-pack', buffer, fileName }, [buffer]);
    },
    cancel() {
      terminate();
    },
  };
}

export function downloadBytes(buffer: ArrayBuffer, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
