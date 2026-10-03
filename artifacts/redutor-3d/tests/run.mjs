import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const scratch = mkdtempSync(join(tmpdir(), 'stl-quality-test-'));
try {
  const outfile = join(scratch, 'quality.cjs');
  buildSync({ entryPoints: [fileURLToPath(new URL('./quality.test.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
