import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Opt-in, read-only remote benchmark. Authentication must work without user input.
const [target, port, remotePath] = process.argv.slice(2);
if (!target || !/^\d+$/.test(port ?? '') || !remotePath?.startsWith('/')) {
  throw new Error('Usage: node scripts/benchmark-download.mjs user@host port /absolute/file');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { runScp, AuthBroker, TransferEngine, scpRemotePath, localArg } = require('../test-results/core.cjs');
const folder = path.join(root, 'test-results', 'performance', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(folder, { recursive: true });
const scp = 'C:\\Windows\\System32\\OpenSSH\\scp.exe';
const ssh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const baseline = path.join(folder, 'native', path.posix.basename(remotePath));
const destination = path.join(folder, 'plugin', path.posix.basename(remotePath));
await fs.mkdir(path.dirname(baseline));
await fs.mkdir(path.dirname(destination));
const remoteUri = 'benchmark-remote://server' + remotePath;

async function command(program, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Benchmark command timed out')); }, 240000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32768); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit ${code}`)); });
  });
}
async function remoteInfo() {
  // Shell single-quote escaping keeps the explicitly supplied path literal.
  const quoted = "'" + remotePath.replaceAll("'", "'\\''") + "'";
  const output = await command(ssh, ['-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, `stat -Lc '%s:%Y' -- ${quoted}`]);
  const [size, mtime] = output.trim().split(':').map(Number);
  if (!Number.isFinite(size) || !Number.isFinite(mtime)) throw new Error('Invalid remote stat result');
  return { size, mtime, kind: 'file' };
}
const initial = await remoteInfo();
console.log(`Source: ${path.posix.basename(remotePath)}, ${initial.size} bytes. Starting native scp.`);
const nativeStarted = Date.now();
await command(scp, ['-P', port, '-o', 'BatchMode=yes', `${target}:${remotePath}`, '.'], path.dirname(baseline));
const nativeMs = Date.now() - nativeStarted;
if ((await fs.stat(baseline)).size !== initial.size) throw new Error('Native download size mismatch');
console.log(`Native scp completed in ${(nativeMs / 1000).toFixed(2)} seconds. Starting plugin transfer engine.`);

const broker = new AuthBroker();
await broker.start();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 240000);
const task = {
  id: 'performance-task', batchId: 'performance-batch', direction: 'download',
  host: { authority: 'benchmark', alias: target, sshPath: ssh, scpPath: scp, hostname: target.split('@').pop(), user: target.split('@')[0], port: Number(port) },
  source: remoteUri, destination: pathToFileURL(destination).toString(), name: path.posix.basename(remotePath),
  state: 'preparing', totalBytes: 0, transferredBytes: 0, speed: 0, progressEstimated: false, createdAt: Date.now(), startedAt: Date.now()
};
let updates = 0, maxEventLoopDelayMs = 0, lastTick = Date.now();
const tick = setInterval(() => { const now = Date.now(); maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - lastTick - 100); lastTick = now; }, 100);
const files = {
  async stat(uri) {
    if (uri === remoteUri) return await remoteInfo();
    try { const info = await fs.lstat(fileURLToPath(uri)); return { size: info.size, mtime: info.mtimeMs, kind: info.isFile() ? 'file' : 'other' }; }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  },
  async rename(from, to) { await fs.rename(fileURLToPath(from), fileURLToPath(to)); },
  async remove(uri) { await fs.unlink(fileURLToPath(uri)); }
};
const engine = new TransferEngine({
  files, collision: async () => { throw new Error('Benchmark destination already exists'); }, cancelBatch() {},
  changed() { updates++; }, log(_task, message) { if (message.startsWith('scp 已') || message.startsWith('分段耗时')) console.log(message); },
  async run(item, signal, onProgress, onAuth) {
    await runScp({ extensionPath: root, host: item.host, auth: broker, signal, onProgress, onAuth, onOutput() {},
      args: ['-P', port, '-S', ssh, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '--', scpRemotePath(target, remotePath, true), localArg(fileURLToPath(item.temporary))] });
  }
});
try {
  await engine.execute(task, controller.signal);
  const pluginTotalMs = Date.now() - task.startedAt;
  const after = await remoteInfo();
  if (after.size !== initial.size || after.mtime !== initial.mtime) throw new Error('Source changed during benchmark');
  const result = {
    date: new Date().toISOString(), bytes: initial.size, file: task.name, nativeMs,
    pluginScpMs: task.scpDurationMs, pluginTotalMs, ratio: pluginTotalMs / nativeMs,
    preparationMs: task.preparationMs, verificationMs: task.verificationMs, commitMs: task.commitMs,
    progressUpdates: updates, maxEventLoopDelayMs,
    limitations: 'Noninteractive authentication for both runs. Real Windows scp and plugin transfer engine; remote metadata uses SSH stat instead of VS Code workspace.fs. Editor and terminal responsiveness not measured.'
  };
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`Report: ${path.join(folder, 'result.json')}`);
} finally {
  clearTimeout(timeout); clearInterval(tick); broker.dispose();
}
