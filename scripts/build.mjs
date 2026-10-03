import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', outfile: 'dist/extension.js', external: ['vscode'], sourcemap: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
console.log(`Built ${manifest.displayName} ${manifest.version}; scp runs directly without a pseudoterminal.`);
