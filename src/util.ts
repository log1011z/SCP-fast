import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CancelledError } from './types';
import type { TransferTask } from './types';

export function expandHome(value: string): string {
  return value.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\$\{userHome\}/g, os.homedir())
    .replace(/%([^%]+)%/g, (whole, key: string) => process.env[key] ?? whole);
}

export function hostFromAuthority(authority: string): string {
  if (!authority.startsWith('ssh-remote+')) throw new Error('仅支持 Remote-SSH 服务器');
  const suffix = authority.slice('ssh-remote+'.length);
  if (/^(?:[0-9a-f]{2})+$/i.test(suffix)) {
    try {
      const value = JSON.parse(Buffer.from(suffix, 'hex').toString('utf8'));
      if (typeof value.hostName === 'string') return value.hostName;
    } catch { /* A normal SSH alias may itself be hexadecimal. */ }
  }
  return suffix;
}

export function assertAlias(alias: string): void {
  if (!alias || alias.startsWith('-') || /[\s\0\r\n:*?\[\]"'\\/]/.test(alias)) {
    throw new Error('SSH 主机条目不是可直接连接的别名，请选择具体 Host 条目');
  }
}

export function assertRemotePath(value: string): void {
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) throw new Error('服务器路径必须是无换行的绝对路径');
  if (value.includes('\\')) throw new Error('Windows OpenSSH 会转换路径中的反斜杠；请先重命名包含反斜杠的服务器目录。');
}

// scp's SFTP download treats the source as a glob. Escape it so selection remains literal.
export function scpRemotePath(alias: string, remotePath: string, source: boolean): string {
  assertAlias(alias);
  assertRemotePath(remotePath);
  // Windows OpenSSH normalizes backslashes to '/', even on remote arguments.
  // Bracket expressions escape glob characters without using a backslash.
  const escapes: Record<string, string> = { '*': '[*]', '?': '[?]', '[': '[[]', ']': '[]]' };
  return `${alias}:${source ? remotePath.replace(/[*?\[\]]/g, char => escapes[char]) : remotePath}`;
}

export function validateWindowsName(name: string): void {
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error(`Windows 不支持这个文件名：${name}。请先在服务器上重命名。`);
  }
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '计算中';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.ceil(seconds % 60)} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function displayPath(value: string): string {
  try {
    const uri = new URL(value);
    return uri.protocol === 'file:' ? fileURLToPath(uri) : decodeURIComponent(uri.pathname);
  } catch { return value; }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function siblingUri(uri: string, name: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `${parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1)}${encodeURIComponent(name)}`;
  return parsed.toString();
}

export function localArg(localPath: string): string {
  // OpenSSH for Windows accepts drive-letter paths. Forward slashes avoid trailing quote issues.
  return path.resolve(localPath).replace(/\\/g, '/');
}

let temporarySequence = 0;
export function temporaryName(name: string): string {
  let prefix = '';
  for (const character of name) {
    if (Buffer.byteLength(prefix + character, 'utf8') > 100) break;
    prefix += character;
  }
  const stamp = new Date().toISOString().replace(/\D/g, '');
  return `.${prefix}.scp-fast-${stamp}-${process.pid}-${++temporarySequence}.part`;
}

/** Internal identifiers and staging filenames never appear in normal task/log presentation. */
export function displayTaskText(task: TransferTask, text: string): string {
  let result = text;
  for (const uri of [task.source, task.destination, task.temporary]) {
    if (uri) result = result.split(uri).join(displayPath(uri));
  }
  if (task.temporary) {
    try {
      const stagingName = decodeURIComponent(new URL(task.temporary).pathname.split('/').pop()!);
      result = result.split(stagingName).join(`${task.name}（临时）`);
      result = result.split(encodeURIComponent(stagingName)).join(encodeURIComponent(`${task.name}（临时）`));
    } catch { /* Legacy task records may not have a valid temporary URI. */ }
  }
  // Covers old 0.1.0 logs and truncated native scp progress lines.
  result = result.replace(/\.scp-fast-[0-9a-f-]+(?:\.part)?/gi, () => `${task.name}（临时）`);
  result = result.split(task.id).join(task.name).split(`[${task.id.slice(0, 8)}]`).join(`[${task.name}]`);
  return result;
}
