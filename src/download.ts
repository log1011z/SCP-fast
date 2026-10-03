import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CancelledError, FileInfo, HostProfile, TransferFiles, TransferTask } from './types';
import type { TaskSeed } from './queue';
import { assertRemotePath, displayPath, throwIfCancelled, validateWindowsName } from './util';

export type DirectoryEntryKind = FileInfo['kind'] | 'unknown';
export interface DownloadReader {
  stat(uri: string): Promise<FileInfo | undefined>;
  readDirectory(uri: string): Promise<[string, DirectoryEntryKind][]>;
}
export interface DownloadPlan { seeds: TaskSeed[]; fileCount: number; directoryCount: number; skipped: number }

async function metadata<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    throwIfCancelled(signal);
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取服务器文件夹超时，请检查 Remote-SSH 连接。')), 20000);
      abort = () => reject(new CancelledError());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export async function planDownload(sources: string[], localDirectory: string, host: HostProfile,
  reader: DownloadReader, signal: AbortSignal, changed: (plan: DownloadPlan) => void = () => {}): Promise<DownloadPlan> {
  const plan: DownloadPlan = { seeds: [], fileCount: 0, directoryCount: 0, skipped: 0 };
  const localRoot = pathToFileURL(path.resolve(localDirectory)).toString();
  const targets = new Map<string, string>();
  const pending: { source: string; destination: string; kind?: DirectoryEntryKind; folderRoot?: string }[] = [];
  for (const source of sources) {
    const uri = new URL(source);
    const authority = decodeURIComponent(uri.href.slice(uri.protocol.length + 2).split('/')[0]);
    if (uri.protocol !== 'vscode-remote:' || authority !== host.authority) throw new Error('一次下载只能选择同一台服务器的文件或文件夹。');
    const remotePath = decodeURIComponent(uri.pathname);
    assertRemotePath(remotePath);
    const name = path.posix.basename(remotePath);
    validateWindowsName(name);
    pending.push({ source, destination: path.join(localDirectory, name) });
  }
  pending.reverse();
  let visited = 0;
  while (pending.length) {
    if (++visited % 250 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    throwIfCancelled(signal);
    const entry = pending.pop()!;
    const kind = entry.kind && entry.kind !== 'unknown' ? entry.kind :
      (await metadata(reader.stat(entry.source), signal))?.kind;
    if (!kind) throw new Error(`服务器路径不存在：${displayPath(entry.source)}`);
    if (kind === 'symlink' || kind === 'other') {
      if (!entry.kind) throw new Error('请选择普通文件或文件夹，不支持符号链接和特殊文件。');
      plan.skipped++; changed(plan); continue;
    }
    const key = path.resolve(entry.destination).toLowerCase();
    const previous = targets.get(key);
    if (previous) {
      if (previous === entry.source) continue;
      throw new Error(`服务器路径在 Windows 上发生同名冲突：${displayPath(previous)} 与 ${displayPath(entry.source)}。请分开下载或先重命名。`);
    }
    targets.set(key, entry.source);
    const folderRoot = entry.folderRoot ?? (kind === 'directory' ? pathToFileURL(entry.destination).toString() : undefined);
    plan.seeds.push({ direction: 'download', host, source: entry.source,
      destination: pathToFileURL(entry.destination).toString(), name: path.basename(entry.destination),
      kind, localRoot, folderRoot });
    if (kind === 'file') plan.fileCount++;
    else {
      plan.directoryCount++;
      const children = await metadata(reader.readDirectory(entry.source), signal);
      for (let index = children.length - 1; index >= 0; index--) {
        const [name, childKind] = children[index];
        if (childKind === 'symlink' || childKind === 'other') { plan.skipped++; continue; }
        validateWindowsName(name);
        const child = new URL(entry.source);
        child.pathname = `${child.pathname.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
        pending.push({ source: child.toString(), destination: path.join(entry.destination, name), kind: childKind, folderRoot });
      }
    }
    changed(plan);
  }
  throwIfCancelled(signal);
  return plan;
}

async function ensureDirectory(directory: string, root: string, signal: AbortSignal): Promise<void> {
  const base = path.resolve(root), target = path.resolve(directory);
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('下载路径超出所选本机目录。');
  throwIfCancelled(signal);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('所选本机保存位置不是文件夹。');
  let current = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    throwIfCancelled(signal);
    current = path.join(current, segment);
    try { await fs.mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`本机目标不是普通文件夹，不能合并：${current}`);
  }
  throwIfCancelled(signal);
}

export async function prepareDownloadTask(task: TransferTask, files: TransferFiles, signal: AbortSignal): Promise<void> {
  if (task.direction !== 'download' || !task.localRoot) return;
  throwIfCancelled(signal);
  if (task.kind === 'directory') {
    const source = await metadata(files.stat(task.source), signal);
    if (source?.kind !== 'directory') throw new Error('服务器文件夹已被移动、删除或替换，请重新选择。');
  }
  const destination = fileURLToPath(task.destination);
  await ensureDirectory(task.kind === 'directory' ? destination : path.dirname(destination), fileURLToPath(task.localRoot), signal);
}
