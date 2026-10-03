import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { AuthBroker } from './auth';
import { HostResolver } from './hosts';
import { VscodeTransferFiles } from './files';
import { TransferQueue, TaskSeed } from './queue';
import { TransferEngine, CollisionChoice } from './transfer';
import { TransferLog } from './log';
import { TransferView, stateNames } from './view';
import { runScp } from './process';
import { TransferTask, terminalStates } from './types';
import { bytes, displayPath, duration, errorMessage, localArg, scpRemotePath, validateWindowsName } from './util';

let activeQueue: TransferQueue | undefined;
let activeBroker: AuthBroker | undefined;
let saveTasks: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const available = process.platform === 'win32' && process.arch === 'x64' && vscode.env.remoteName === 'ssh-remote';
  await vscode.commands.executeCommand('setContext', 'scpFast.available', available);
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const files = new VscodeTransferFiles();
  const hosts = new HostResolver(context);
  const log = new TransferLog(path.join(context.globalStorageUri.fsPath, 'logs'));
  await log.initialize();
  const broker = new AuthBroker();
  await broker.start();
  activeBroker = broker;
  const engine = new TransferEngine({
    files,
    collision: (task, changed, signal) => collision(task, changed, signal),
    cancelBatch: batchId => queue.cancelBatch(batchId),
    changed: () => queue.update(),
    log: (task, message) => log.write(task, message),
    run: async (task, signal, onProgress, onAuth) => {
      const args = [...(task.host.configPath ? ['-F', task.host.configPath] : []), '-S', task.host.sshPath,
        '-o', 'BatchMode=no', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
      if (vscode.workspace.getConfiguration('scpFast').get<boolean>('diagnosticLogging')) args.push('-v');
      const source = vscode.Uri.parse(task.source);
      const temporary = vscode.Uri.parse(task.temporary!);
      if (task.direction === 'download') args.push('--', scpRemotePath(task.host.alias, source.path, true), localArg(temporary.fsPath));
      else args.push('--', localArg(source.fsPath), scpRemotePath(task.host.alias, temporary.path, false));
      log.write(task, `调用本机 scp；程序 ${task.host.scpPath}；SSH 配置 ${task.host.configPath ?? '系统默认'}；协议 OpenSSH 默认 SFTP`);
      await runScp({ extensionPath: context.extensionPath, host: task.host, args, auth: broker, signal,
        onProgress, onAuth, onOutput: output => log.output(task, output) });
    }
  });
  let view: TransferView;
  let persistedSignature = '';
  let persistence = Promise.resolve();
  const persist = (): Promise<void> => {
    const remembered = [...queue.tasks.filter(task => terminalStates.has(task.state)).slice(-100),
      ...queue.tasks.filter(task => !terminalStates.has(task.state))];
    const snapshot = remembered.map(task => ({ ...task, host: { ...task.host } }));
    persistence = persistence.then(() => context.workspaceState.update('scpFast.tasks', snapshot))
      .catch(error => { log.channel.appendLine(`任务记录保存失败：${errorMessage(error)}`); });
    return persistence;
  };
  const queue = new TransferQueue(async (task, signal) => {
    await log.open(task);
    try { await engine.execute(task, signal); }
    finally { await log.close(task); }
  }, () => {
    view?.update();
    const signature = queue.tasks.map(task => `${task.id}:${task.state}:${task.temporary ?? ''}`).join('|');
    if (signature !== persistedSignature) { persistedSignature = signature; void persist(); }
  }, async task => {
    const elapsed = Math.max(0.001, (task.transferDurationMs ?? 0) / 1000);
    log.channel.appendLine(`${task.name}：${stateNames[task.state]}；总耗时 ${duration(((task.finishedAt ?? Date.now()) - (task.startedAt ?? Date.now())) / 1000)}；平均传输速度 ${bytes(task.totalBytes / elapsed)}/s${task.error ? `；${task.error}` : ''}`);
    await persist();
    if (task.state === 'success') {
      if (task.direction === 'upload') {
        void vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer').then(undefined,
          error => { log.channel.appendLine(`上传已成功；资源管理器刷新失败：${errorMessage(error)}`); });
      }
      // One summary notification per batch; independent tasks can keep running.
      const pending = queue.tasks.some(value => value.batchId === task.batchId && value.state === 'queued');
      if (!pending) {
        const batch = queue.tasks.filter(value => value.batchId === task.batchId);
        const done = batch.filter(value => value.state === 'success').length;
        void vscode.window.showInformationMessage(`SCP-Fast：本批次完成 ${done}/${batch.length} 个文件`,
          ...(task.direction === 'download' ? ['打开本机文件夹', '查看队列'] : ['查看队列'])).then(action => {
          if (action === '打开本机文件夹') void openFolder(task);
          else if (action === '查看队列') void vscode.commands.executeCommand('scpFast.transfers.focus');
        });
      }
    } else if (task.state === 'failed') {
      void vscode.window.showErrorMessage(`SCP-Fast：${task.name} — ${task.error}`, '查看日志', '从头重试').then(action => {
        if (action === '查看日志') void log.show(task);
        if (action === '从头重试') queue.retry(task.id);
      });
    }
  });
  activeQueue = queue;
  saveTasks = persist;
  view = new TransferView(queue);
  const tree = vscode.window.createTreeView('scpFast.transfers', { treeDataProvider: view, showCollapseAll: false });
  queue.restore(context.workspaceState.get<TransferTask[]>('scpFast.tasks', []));
  context.subscriptions.push(log, view, tree, vscode.workspace.registerTextDocumentContentProvider('scp-fast-log', log));

  const recentKey = (taskHost: string, kind: 'download' | 'upload') => `scpFast.recent.${taskHost}.${kind}`;
  async function defaultLocal(host: string, kind: 'download' | 'upload'): Promise<vscode.Uri> {
    const saved = context.globalState.get<string>(recentKey(host, kind));
    if (saved) {
      try { const info = await fs.stat(saved); if (info.isDirectory()) return vscode.Uri.file(saved); } catch { /* Fall back to home. */ }
    }
    return vscode.Uri.file(os.homedir());
  }
  function remoteUri(value?: vscode.Uri): vscode.Uri {
    const uri = value ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'vscode-remote' || !uri.authority.startsWith('ssh-remote+') || vscode.env.remoteName !== 'ssh-remote') {
      throw new Error('请在 Remote-SSH 窗口中右键服务器文件或文件夹。');
    }
    return uri;
  }
  async function download(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
    const target = remoteUri(clicked);
    const resources = [...new Map((selected?.length && selected.some(uri => uri.toString() === target.toString()) ? selected : [target])
      .map(uri => [uri.toString(), uri])).values()];
    const host = await hosts.resolve(target.authority);
    if (!host) return;
    for (const uri of resources) {
      if (uri.scheme !== target.scheme || uri.authority !== target.authority) throw new Error('一次下载只能选择同一台服务器的文件。');
      const info = await files.stat(uri.toString());
      if (!info || info.kind !== 'file') throw new Error('请选择普通文件；第一版不下载目录或符号链接。');
      validateWindowsName(path.posix.basename(uri.path));
    }
    const result = await vscode.window.showOpenDialog({ title: 'SCP-Fast：选择本机下载目录', openLabel: '下载到此目录',
      defaultUri: await defaultLocal(target.authority, 'download'), canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    if (!result?.length) return;
    if (result[0].scheme !== 'file') throw new Error('下载目标必须是 Windows 本机目录。');
    await context.globalState.update(recentKey(target.authority, 'download'), result[0].fsPath);
    const seeds = resources.map(uri => ({ direction: 'download' as const, host, source: uri.toString(),
      destination: vscode.Uri.file(path.join(result[0].fsPath, path.posix.basename(uri.path))).toString(), name: path.posix.basename(uri.path) }));
    queue.enqueue(seeds);
    await vscode.commands.executeCommand('scpFast.transfers.focus');
  }
  async function upload(clicked?: vscode.Uri): Promise<void> {
    const target = remoteUri(clicked ?? vscode.workspace.workspaceFolders?.[0]?.uri);
    const info = await files.stat(target.toString());
    if (!info || info.kind !== 'directory') throw new Error('请右键一个普通服务器文件夹作为上传目标。');
    const host = await hosts.resolve(target.authority);
    if (!host) return;
    const result = await vscode.window.showOpenDialog({ title: 'SCP-Fast：选择本机文件', openLabel: '上传到服务器',
      defaultUri: await defaultLocal(target.authority, 'upload'), canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
    if (!result?.length) return;
    const seeds: TaskSeed[] = [];
    for (const uri of result) {
      if (uri.scheme !== 'file') throw new Error('上传来源必须是 Windows 本机文件。');
      const file = await files.stat(uri.toString());
      if (!file || file.kind !== 'file') throw new Error('上传仅支持本机普通文件。');
      const name = path.basename(uri.fsPath);
      seeds.push({ direction: 'upload', host, source: uri.toString(), destination: vscode.Uri.joinPath(target, name).toString(), name });
    }
    await context.globalState.update(recentKey(target.authority, 'upload'), path.dirname(result[0].fsPath));
    queue.enqueue(seeds);
    await vscode.commands.executeCommand('scpFast.transfers.focus');
  }
  const command = (name: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: any[]) => {
      try { await handler(...args); }
      catch (error) { void vscode.window.showErrorMessage(`SCP-Fast：${errorMessage(error)}`, '查看日志').then(action => { if (action) void log.show(); }); }
    }));
  };
  command('scpFast.download', download);
  command('scpFast.downloadMany', download);
  command('scpFast.upload', upload);
  command('scpFast.showQueue', () => vscode.commands.executeCommand('scpFast.transfers.focus'));
  command('scpFast.cancel', (task?: TransferTask) => queue.cancel(task?.id));
  command('scpFast.retry', (task?: TransferTask) => { if (task) queue.retry(task.id); });
  command('scpFast.openFolder', openFolder);
  command('scpFast.showLog', (task?: TransferTask) => log.show(task));
  command('scpFast.clearFinished', () => queue.clearFinished());
  command('scpFast.selectHost', async () => {
    const uri = remoteUri(vscode.workspace.workspaceFolders?.[0]?.uri);
    const profile = await hosts.resolve(uri.authority, true);
    if (profile) void vscode.window.showInformationMessage(`SCP-Fast：当前服务器使用 SSH 条目 ${profile.alias}`);
  });
}

async function openFolder(task?: TransferTask): Promise<void> {
  if (!task || task.direction !== 'download' || task.state !== 'success') return;
  const destination = vscode.Uri.parse(task.destination);
  const explorer = path.join(process.env.WINDIR ?? 'C:\\Windows', 'explorer.exe');
  const { spawn } = await import('node:child_process');
  const child = spawn(explorer, ['/select,', destination.fsPath], { windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
  child.on('error', error => { void vscode.window.showErrorMessage(`无法打开本机文件夹：${error.message}`); });
  child.unref();
}

function collision(task: TransferTask, changed: boolean, signal: AbortSignal): Promise<CollisionChoice> {
  return new Promise(resolve => {
    const picker = vscode.window.createQuickPick<{ label: string; choice: CollisionChoice; description?: string }>();
    picker.title = changed ? 'SCP-Fast：目标文件在传输期间发生变化' : 'SCP-Fast：目标已有同名文件';
    picker.placeholder = `${task.name} · ${displayPath(task.destination)}`;
    picker.ignoreFocusOut = true;
    picker.items = [
      { label: '跳过此文件', choice: 'skip' },
      { label: '覆盖已有文件', choice: 'overwrite', description: '传输成功后替换；仅确认这个文件' },
      { label: '取消本批次', choice: 'cancelBatch' }
    ];
    let settled = false;
    const finish = (choice: CollisionChoice) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', cancel);
      picker.hide(); picker.dispose(); resolve(choice);
    };
    const cancel = () => finish('cancelBatch');
    picker.onDidHide(cancel);
    picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) finish(item.choice); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { finish('cancelBatch'); return; }
    picker.show();
  });
}

export async function deactivate(): Promise<void> {
  await activeQueue?.stop();
  await saveTasks?.();
  activeBroker?.dispose();
  activeQueue = undefined; activeBroker = undefined; saveTasks = undefined;
}
