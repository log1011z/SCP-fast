import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['tests/entry.ts'], bundle: true, platform: 'node', format: 'cjs',
  outfile: 'test-results/core.cjs', alias: { vscode: path.resolve('tests/vscode-stub.cjs') } });
await import('../tests/smoke.mjs');
