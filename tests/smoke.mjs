import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
const require = createRequire(import.meta.url);
const { AuthBroker, runScp, TransferQueue, TransferEngine, scpRemotePath, localArg, getAccepted,
  planDownload, prepareDownloadTask } = require('../test-results/core.cjs');
const workspace = path.resolve('.');
const fixture = path.join(workspace, 'test-results', `smoke-${crypto.randomUUID()}`);
const remoteRoot = path.join(fixture, 'server');
await fs.mkdir(remoteRoot, { recursive: true });
const sourceBytes = crypto.randomBytes(2 * 1024 * 1024);
const sourceName = 'file [one] 你好.bin';
await fs.writeFile(path.join(remoteRoot, sourceName), sourceBytes);
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const flags = utils.sftp.OPEN_MODE, status = utils.sftp.STATUS_CODE;
const connections = new Set();
function remoteFile(value) {
  const candidate = path.resolve(remoteRoot, '.' + value.replaceAll('/', path.sep));
  if (candidate !== remoteRoot && !candidate.startsWith(remoteRoot + path.sep)) throw new Error('Outside smoke fixture');
  return candidate;
}
function attributes(info) {
  return { mode: info.isDirectory() ? 0o040755 : 0o100644, uid: 1000, gid: 1000, size: info.size,
    atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) };
}
const server = new Server({ hostKeys: [privateKey] }, client => {
  connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
  client.on('authentication', auth => {
    if (auth.method === 'password' && auth.password === 'scp-fast-smoke-password') auth.accept();
    else if (auth.method === 'keyboard-interactive') {
      auth.prompt([{ prompt: 'Password:', echo: false }, { prompt: 'Verification code:', echo: false }], answers => {
        if (answers[0] === 'scp-fast-smoke-password' && answers[1] === '123456') auth.accept(); else auth.reject();
      });
    } else auth.reject(['password', 'keyboard-interactive']);
  });
  client.on('ready', () => client.on('session', accept => accept().on('sftp', acceptSftp => {
    const sftp = acceptSftp();
    const handles = new Map(); let nextHandle = 0;
    const respond = (req, operation) => Promise.resolve().then(operation).catch(error => {
      sftp.status(req, error.code === 'ENOENT' ? status.NO_SUCH_FILE : status.FAILURE, error.message);
    });
    for (const event of ['STAT', 'LSTAT']) sftp.on(event, (req, file) => respond(req, async () => sftp.attrs(req, attributes(await fs.stat(remoteFile(file))))));
    sftp.on('REALPATH', (req, file) => sftp.name(req, [{ filename: file === '.' ? '/' : file, longname: file, attrs: {} }]));
    sftp.on('OPENDIR', (req, file) => respond(req, async () => {
      const entries = await fs.readdir(remoteFile(file));
      const id = Buffer.alloc(4); id.writeUInt32BE(++nextHandle);
      handles.set(id.toString('hex'), { directory: file, entries, sent: false, async close() {} });
      sftp.handle(req, id);
    }));
    sftp.on('READDIR', (req, id) => respond(req, async () => {
      const directory = handles.get(id.toString('hex'));
      if (directory.sent) { sftp.status(req, status.EOF); return; }
      directory.sent = true;
      const entries = await Promise.all(directory.entries.map(async name => ({ filename: name, longname: name,
        attrs: attributes(await fs.stat(remoteFile(path.posix.join(directory.directory, name)))) })));
      sftp.name(req, entries);
    }));
    sftp.on('OPEN', (req, file, mode) => respond(req, async () => {
      const handle = await fs.open(remoteFile(file), mode & flags.WRITE ? (mode & flags.TRUNC ? 'w' : 'a') : 'r');
      const id = Buffer.alloc(4); id.writeUInt32BE(++nextHandle);
      handles.set(id.toString('hex'), handle); sftp.handle(req, id);
    }));
    sftp.on('FSTAT', (req, id) => respond(req, async () => sftp.attrs(req, attributes(await handles.get(id.toString('hex')).stat()))));
    sftp.on('READ', (req, id, offset, length) => respond(req, async () => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handles.get(id.toString('hex')).read(buffer, 0, length, offset);
      if (bytesRead) sftp.data(req, buffer.subarray(0, bytesRead)); else sftp.status(req, status.EOF);
    }));
    sftp.on('WRITE', (req, id, offset, data) => respond(req, async () => {
      await handles.get(id.toString('hex')).write(data, 0, data.length, offset); sftp.status(req, status.OK);
    }));
    sftp.on('CLOSE', (req, id) => respond(req, async () => {
      const key = id.toString('hex'); await handles.get(key).close(); handles.delete(key); sftp.status(req, status.OK);
    }));
    sftp.on('REMOVE', (req, file) => respond(req, async () => { await fs.unlink(remoteFile(file)); sftp.status(req, status.OK); }));
    sftp.on('RENAME', (req, from, to) => respond(req, async () => { await fs.rename(remoteFile(from), remoteFile(to)); sftp.status(req, status.OK); }));
    sftp.on('SETSTAT', (req) => sftp.status(req, status.OK));
    sftp.on('FSETSTAT', (req) => sftp.status(req, status.OK));
    sftp.on('end', () => {
      for (const handle of handles.values()) void handle.close().catch(() => {});
      sftp._protocol.exitStatus(sftp.outgoing.id, 0);
      sftp.end();
    });
  })));
});
const auth = new AuthBroker();
await auth.start();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const config = path.join(fixture, 'ssh_config');
await fs.writeFile(config, `Host scp-fast-smoke\n  HostName 127.0.0.1\n  Port ${port}\n  User smoke\n  StrictHostKeyChecking no\n  UserKnownHostsFile NUL\n  PreferredAuthentications password\n  PubkeyAuthentication no\n`);
const ssh = path.join(process.env.WINDIR, 'System32/OpenSSH/ssh.exe');
const scp = path.join(process.env.WINDIR, 'System32/OpenSSH/scp.exe');
const host = { authority: 'ssh-remote+scp-fast-smoke', alias: 'scp-fast-smoke', hostname: '127.0.0.1', user: 'smoke', port, sshPath: ssh, scpPath: scp, configPath: config };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let nativeProgress = 0, prompts = 0;
async function actualScp(source, destination, keyboardInteractive = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let output = '';
  try {
    await runScp({ extensionPath: workspace, host, auth, signal: controller.signal,
      args: ['-F', config, '-S', ssh, '-o', 'BatchMode=no',
        ...(keyboardInteractive ? ['-o', 'PreferredAuthentications=keyboard-interactive'] : []), '--', source, destination],
      onProgress() { nativeProgress++; }, onAuth(waiting) { if (waiting) prompts++; },
      onOutput(chunk) { output += chunk; } });
  } catch (error) { await fs.writeFile(path.join(fixture, 'failure.log'), output); throw error; }
  finally { clearTimeout(timeout); }
}

try {
  const download = path.join(fixture, 'download.bin');
  await actualScp(scpRemotePath(host.alias, '/' + sourceName, true), localArg(download));
  assert.equal(hash(await fs.readFile(download)), hash(sourceBytes));
  await actualScp(localArg(download), scpRemotePath(host.alias, '/uploaded.bin', false), true);
  assert.equal(hash(await fs.readFile(path.join(remoteRoot, 'uploaded.bin'))), hash(sourceBytes));
  assert.ok(prompts >= 3 && getAccepted() >= 3, 'Native OpenSSH must request password and two-step authentication through packaged askpass');
  assert.equal(nativeProgress, 0, 'Direct scp uses pipes; transfer progress must come from target-file sampling');
  console.log('PASS: direct Windows scp upload/download, content equality and packaged password/two-step askpass (loopback fixture).');

  // One real folder scenario: Chinese/glob names, nesting, empty directories, skipped links.
  const folderName = '模型 [文件夹]';
  const remoteFolder = path.join(remoteRoot, folderName);
  await fs.mkdir(path.join(remoteFolder, '子目录'), { recursive: true });
  await fs.mkdir(path.join(remoteFolder, '空目录'));
  await fs.writeFile(path.join(remoteFolder, sourceName), sourceBytes);
  await fs.writeFile(path.join(remoteFolder, '子目录', '说明.txt'), '中文文件夹下载');
  const localFolder = path.join(fixture, 'folder-download');
  await fs.mkdir(localFolder);
  const folderSource = `vscode-remote://${host.authority}/${encodeURIComponent(folderName)}`;
  const localPath = uri => fileURLToPath(uri);
  const diskInfo = async value => {
    try {
      const info = await fs.lstat(value);
      return { size: info.size, mtime: info.mtimeMs, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' };
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const folderReader = {
    async stat(uri) { return await diskInfo(remoteFile(decodeURIComponent(new URL(uri).pathname))); },
    async readDirectory(uri) {
      const location = remoteFile(decodeURIComponent(new URL(uri).pathname));
      const entries = await fs.readdir(location, { withFileTypes: true });
      const mapped = entries.map(item => [item.name, item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'symlink']);
      if (location === remoteFolder) mapped.push(['不跟随的链接', 'symlink']);
      return mapped;
    }
  };
  const plan = await planDownload([folderSource], localFolder, host, folderReader, new AbortController().signal);
  assert.equal(plan.fileCount, 2); assert.equal(plan.directoryCount, 3); assert.equal(plan.skipped, 1);
  const folderFiles = {
    async stat(uri) { return uri.startsWith('file:') ? await diskInfo(localPath(uri)) : await folderReader.stat(uri); },
    async rename(from, to) { await fs.rename(localPath(from), localPath(to)); },
    async remove(uri) { await fs.unlink(localPath(uri)); }
  };
  let folderQueue;
  const folderEngine = new TransferEngine({ files: folderFiles, collision: async () => 'overwrite',
    cancelBatch: id => folderQueue.cancelBatch(id), changed() {}, log() {},
    async run(task) {
      await actualScp(scpRemotePath(host.alias, decodeURIComponent(new URL(task.source).pathname), true), localArg(localPath(task.temporary)));
    }
  });
  folderQueue = new TransferQueue(async (task, signal) => {
    try {
      await prepareDownloadTask(task, folderFiles, signal);
      if (task.kind === 'directory') task.state = 'success';
      else await folderEngine.execute(task, signal);
    } catch (error) { if (task.kind === 'directory') folderQueue.cancelDescendants(task); throw error; }
  }, () => {}, async () => {});
  const folderTasks = folderQueue.enqueue(plan.seeds);
  assert.equal(folderQueue.records.length, 1, 'Folder contents must appear as one record');
  assert.equal(folderQueue.records[0].name, folderName);
  assert.equal(folderQueue.records[0].state, 'queued');
  await waitFor(() => folderTasks.every(task => ['success', 'failed', 'cancelled'].includes(task.state)));
  assert(folderTasks.every(task => task.state === 'success'), folderTasks.map(task => task.error).filter(Boolean).join('\n'));
  assert.equal(folderQueue.records[0].state, 'success');
  assert.equal(folderQueue.records[0].completedFiles, 2);
  assert.equal(folderQueue.records[0].transferredBytes, sourceBytes.length + Buffer.byteLength('中文文件夹下载'));
  assert.equal(folderQueue.history().length, 1);
  assert.deepEqual(await fs.readFile(path.join(localFolder, folderName, sourceName)), sourceBytes);
  assert.equal(await fs.readFile(path.join(localFolder, folderName, '子目录', '说明.txt'), 'utf8'), '中文文件夹下载');
  assert((await fs.stat(path.join(localFolder, folderName, '空目录'))).isDirectory());
  assert.equal((await fs.readdir(path.join(localFolder, folderName))).filter(name => name.endsWith('.part')).length, 0);

  const cancelledScan = new AbortController();
  await assert.rejects(planDownload([folderSource], localFolder, host, folderReader, cancelledScan.signal,
    () => cancelledScan.abort()), /任务已取消/);
  const blockedRoot = path.join(fixture, 'folder-blocked');
  await fs.mkdir(blockedRoot);
  const originalTarget = path.join(blockedRoot, folderName);
  await fs.writeFile(originalTarget, 'keep original file');
  const blockedPlan = await planDownload([folderSource], blockedRoot, host, folderReader, new AbortController().signal);
  const blockedTasks = folderQueue.enqueue(blockedPlan.seeds);
  await waitFor(() => blockedTasks.every(task => ['failed', 'cancelled'].includes(task.state)));
  assert.equal(blockedTasks[0].state, 'failed');
  assert(blockedTasks.slice(1).every(task => task.state === 'cancelled'));
  assert.equal(folderQueue.records.length, 2, 'Separate selections remain separate folder records');
  assert.equal(folderQueue.records[1].state, 'failed');
  assert.equal(await fs.readFile(originalTarget, 'utf8'), 'keep original file');
  await fs.unlink(originalTarget);
  const directoryRetry = folderQueue.retry(blockedTasks[0].id);
  assert.equal(directoryRetry.length, blockedTasks.length);
  await waitFor(() => directoryRetry.every(task => ['success', 'failed'].includes(task.state)));
  assert(directoryRetry.every(task => task.state === 'success'));
  const restored = new TransferQueue(async () => {}, () => {}, async () => {});
  restored.restore(JSON.parse(JSON.stringify(folderQueue.history())));
  assert.equal(restored.records.length, 3);
  assert.equal(restored.tasks.length, folderQueue.tasks.length);
  restored.clearFinished();
  assert.equal(restored.records.length, 0);
  await restored.stop();
  await folderQueue.stop();
  console.log('PASS: native scp folder download, nested/empty Chinese directories, skipped links, scan cancellation and safe folder retry.');

  // One grouped-record scenario: partial progress, clear while active, cancellation and retry.
  let grouped, releaseFile;
  let holdFile = true;
  const held = new Promise(resolve => { releaseFile = resolve; });
  grouped = new TransferQueue(async (task, signal) => {
    if (task.kind !== 'directory') {
      task.totalBytes = 100; task.transferredBytes = 50; task.state = 'transferring';
      if (holdFile) await held;
      signal.throwIfAborted();
      task.transferredBytes = 100;
    }
    task.state = 'success';
  }, () => {}, async () => {});
  const groupedTasks = grouped.enqueue(plan.seeds);
  await waitFor(() => grouped.active?.kind === 'file');
  assert.equal(grouped.records[0].state, 'transferring', 'Successful directory preparation must not complete the folder');
  assert.equal(grouped.records[0].progressPercent, 25);
  grouped.clearFinished();
  assert.equal(grouped.tasks.length, plan.seeds.length, 'Clearing history must retain all members of an active folder');
  const interrupted = new TransferQueue(async () => {}, () => {}, async () => {});
  interrupted.restore(grouped.history());
  assert.equal(interrupted.records[0].state, 'interrupted');
  await interrupted.stop();
  grouped.cancel(groupedTasks[0].id);
  releaseFile();
  await waitFor(() => !grouped.active);
  assert.equal(grouped.records[0].state, 'cancelled');
  assert(groupedTasks.filter(task => task.kind === 'file').every(task => task.state === 'cancelled'));
  holdFile = false;
  const groupedRetry = grouped.retry(groupedTasks[0].id);
  assert(groupedRetry.length > 0, 'Retry must work when the root directory itself succeeded');
  await waitFor(() => groupedRetry.every(task => task.state === 'success'));
  assert.equal(grouped.records.length, 2);
  assert.equal(grouped.records[1].name, folderName);
  assert.equal(grouped.records[1].state, 'success');
  const oldHistory = new TransferQueue(async () => {}, () => {}, async () => {});
  oldHistory.restore(grouped.tasks);
  assert.equal(oldHistory.records.length, 2, 'Migrate old flat folder history');
  await oldHistory.stop();
  await grouped.stop();
  console.log('PASS: one folder record, aggregated progress, grouped history/restore, cancel and retry.');

  // One compact queue scenario: overwrite only after success, FIFO, failure, cancel, retry.
  const storage = new Map();
  const source = 'file:///source', destination = 'file:///destination';
  storage.set(source, { data: Buffer.from('new'), mtime: 1 });
  storage.set(destination, { data: Buffer.from('old'), mtime: 1 });
  const files = {
    async stat(uri) { const file = storage.get(uri); return file && { size: file.data.length, mtime: file.mtime, kind: 'file' }; },
    async rename(from, to) { storage.set(to, storage.get(from)); storage.delete(from); },
    async remove(uri) { storage.delete(uri); }
  };
  const order = [];
  let fail = true;
  let queue;
  const engine = new TransferEngine({ files, collision: async () => 'overwrite', cancelBatch: id => queue.cancelBatch(id), changed() {}, log() {},
    async run(task, signal) {
      order.push(task.name);
      storage.set(task.temporary, { data: Buffer.from('new'), mtime: 1 });
      if (task.name === 'first' && fail) throw new Error('simulated interruption');
      if (task.name === 'cancel') { queue.cancel(task.id); signal.throwIfAborted(); }
    }
  });
  queue = new TransferQueue((task, signal) => engine.execute(task, signal), () => {}, async () => {});
  const seed = name => ({ direction: 'download', host, source, destination, name });
  const [first] = queue.enqueue([seed('first')]);
  await waitFor(() => first.state === 'failed');
  assert.equal(storage.get(destination).data.toString(), 'old');
  assert.equal(first.temporary, undefined);
  fail = false;
  const [retry] = queue.retry(first.id);
  const [cancel, last] = queue.enqueue([seed('cancel'), seed('last')]);
  await waitFor(() => last.state === 'success');
  assert.equal(retry.state, 'success'); assert.equal(cancel.state, 'cancelled');
  assert.equal(storage.get(destination).data.toString(), 'new');
  assert.deepEqual(order, ['first', 'first', 'cancel', 'last']);
  await queue.stop();
  console.log('PASS: sequential queue, safe overwrite, failed-transfer cleanup, cancellation and fresh retry.');
  await fs.writeFile(path.join(workspace, 'test-results', 'smoke-result.json'), JSON.stringify({
    passed: true, time: new Date().toISOString(), fixture, nativeProgress, authPrompts: prompts,
    fileBytes: sourceBytes.length, scope: 'Windows real scp loopback; VS Code dialog simulated; queue scenario',
    realRemoteSshWindowVerified: false, production400MbBenchmarkVerified: false,
    folderDownloadVerified: true, folderFiles: plan.fileCount, folderDirectories: plan.directoryCount,
    folderRecordsVerified: true
  }, null, 2));
} finally {
  auth.dispose();
  for (const client of connections) client.end();
  await new Promise(resolve => server.close(resolve));
}

async function waitFor(condition) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Queue smoke timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
