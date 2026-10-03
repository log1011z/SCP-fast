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
import { planDownload, prepareDownloadTask } from './download';
import { CancelledError, TransferTask, terminalStates } from './types';
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
    try {
      await prepareDownloadTask(task, files, signal);
      if (task.kind === 'directory') {
        task.state = 'success';
        log.write(task, `本机文件夹已准备：${task.destination}`);
      } else await engine.execute(task, signal);
    } catch (error) {
      if (task.state === 'preparing') log.write(task, `下载准备失败或取消：${errorMessage(error)}`);
      if (task.kind === 'directory') queue.cancelDescendants(task);
      throw error;
    }
    finally { await log.close(task); }
  }, () => {
    view?.update();
    const signature = queue.tasks.map(task => `${task.id}:${task.state}:${task.temporary ?? ''}`).join('|');
    if (signature !== persistedSignature) { persistedSignature = signature; void persist(); }
  }, async task => {
    const elapsed = (task.transferDurationMs ?? Math.max(0, (task.scpDurationMs ?? 0) - (task.authenticationWaitMs ?? 0))) / 1000;
    const average = task.kind !== 'directory' && elapsed > 0 ? `；平均传输速度 ${bytes((task.state === 'success' ? task.totalBytes : task.transferredBytes) / elapsed)}/s` : '';
    log.channel.appendLine(`${task.name}：${stateNames[task.state]}；总耗时 ${duration(((task.finishedAt ?? Date.now()) - (task.startedAt ?? Date.now())) / 1000)}${average}${task.error ? `；${task.error}` : ''}`);
    await persist();
    if (task.state === 'success') {
      if (task.direction === 'upload') {
        void vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer').then(undefined,
          error => { log.channel.appendLine(`上传已成功；资源管理器刷新失败：${errorMessage(error)}`); });
      }
    } else if (task.state === 'failed') {
      void vscode.window.showErrorMessage(`SCP-Fast：${task.name} — ${task.error}`, '查看日志', '从头重试').then(action => {
        if (action === '查看日志') void log.show(task);
        if (action === '从头重试') queue.retry(task.id);
      });
    }
    const batch = queue.tasks.filter(value => value.batchId === task.batchId);
    if (batch.every(value => terminalStates.has(value.state)) && (batch.length > 1 || task.state === 'success')) {
      const fileTasks = batch.filter(value => value.kind !== 'directory');
      const done = fileTasks.filter(value => value.state === 'success').length;
      const directories = batch.filter(value => value.kind === 'directory' && value.state === 'success').length;
      const failed = batch.filter(value => value.state === 'failed').length;
      const skipped = fileTasks.filter(value => value.state === 'skipped').length;
      const cancelled = fileTasks.filter(value => value.state === 'cancelled').length;
      const message = `SCP-Fast：${fileTasks.length ? `本批次完成 ${done}/${fileTasks.length} 个文件` : `已创建 ${directories} 个文件夹`}` +
        `${failed ? `；${failed} 个任务失败` : ''}${skipped ? `；${skipped} 个文件跳过` : ''}${cancelled ? `；${cancelled} 个文件取消` : ''}`;
      const downloaded = batch.find(value => value.direction === 'download' && value.state === 'success');
      const notify = failed ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void notify(message, ...(downloaded ? ['打开本机文件夹', '查看队列'] : ['查看队列'])).then(action => {
        if (action === '打开本机文件夹') void openFolder(downloaded);
        else if (action === '查看队列') void vscode.commands.executeCommand('scpFast.transfers.focus');
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
      if (uri.scheme !== target.scheme || uri.authority !== target.authority) throw new Error('一次下载只能选择同一台服务器的文件或文件夹。');
    }
    const result = await vscode.window.showOpenDialog({ title: 'SCP-Fast：选择本机下载目录', openLabel: '下载到此目录',
      defaultUri: await defaultLocal(target.authority, 'download'), canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    if (!result?.length) return;
    if (result[0].scheme !== 'file') throw new Error('下载目标必须是 Windows 本机目录。');
    await context.globalState.update(recentKey(target.authority, 'download'), result[0].fsPath);
    const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'SCP-Fast：准备下载文件和文件夹', cancellable: true }, async (progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      let lastUpdate = 0;
      try {
        return await planDownload(resources.map(uri => uri.toString()), result[0].fsPath, host, files, controller.signal, value => {
          if (Date.now() - lastUpdate < 200) return;
          lastUpdate = Date.now();
          progress.report({ message: `已找到 ${value.fileCount} 个文件、${value.directoryCount} 个文件夹` });
        });
      } finally { subscription.dispose(); }
    });
    queue.enqueue(plan.seeds);
    if (plan.skipped) void vscode.window.showWarningMessage(`SCP-Fast：已跳过 ${plan.skipped} 个符号链接或特殊文件。`);
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
      catch (error) {
        if (error instanceof CancelledError) return;
        void vscode.window.showErrorMessage(`SCP-Fast：${errorMessage(error)}`, '查看日志').then(action => { if (action) void log.show(); });
      }
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
  const destination = vscode.Uri.parse(task.folderRoot ?? task.destination);
  const explorer = path.join(process.env.WINDIR ?? 'C:\\Windows', 'explorer.exe');
  const { spawn } = await import('node:child_process');
  const child = spawn(explorer, task.folderRoot || task.kind === 'directory' ? [destination.fsPath] : ['/select,', destination.fsPath],
    { windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
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
