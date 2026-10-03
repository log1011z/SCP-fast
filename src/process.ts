import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { AuthBroker } from './auth';
import { CancelledError, HostProfile } from './types';
import { throwIfCancelled } from './util';
import type { ScpProgress } from './progress';

export async function runPlain(program: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const settle = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout || stderr);
    };
    const timer = setTimeout(() => {
      void terminateTree(child.pid).finally(() => settle(new Error('本机 SSH 命令超时，请检查配置中的 Match exec 或 ProxyCommand。')));
    }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { stdout = (stdout + data).slice(-1024 * 1024); });
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-65536); });
    child.once('error', error => settle(error));
    child.once('close', code => settle(code === 0 ? undefined : new Error(stderr.trim() || `SSH 命令退出码：${code}`)));
  });
}

export async function terminateTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  await new Promise<void>(resolve => {
    const child = spawn(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 8000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

export interface ScpRunOptions {
  extensionPath: string;
  host: HostProfile;
  args: string[];
  auth: AuthBroker;
  signal: AbortSignal;
  onProgress(progress: ScpProgress): void;
  onAuth(waiting: boolean): void;
  onOutput(output: string): void;
}

export async function runScp(options: ScpRunOptions): Promise<void> {
  throwIfCancelled(options.signal);
  let child: ReturnType<typeof spawn> | undefined;
  let cancelRequested = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) stopping = terminateTree(child?.pid);
    return stopping;
  };
  const authSession = options.auth.session(options.signal, {
    onPrompt: () => options.onAuth(true),
    onAnswer: () => options.onAuth(false),
    onCancel: () => { cancelRequested = true; void stop(); }
  });
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, authSession.env, {
      SSH_ASKPASS: path.join(options.extensionPath, 'bin/scp-fast-askpass.exe'),
      SSH_ASKPASS_REQUIRE: 'force',
      LC_ALL: 'C', LANG: 'C'
    });
    child = spawn(options.host.scpPath, options.args, {
      cwd: path.dirname(options.host.scpPath), env, windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise<void>((resolve, reject) => {
      let tail = '', settled = false;
      const abort = () => { cancelRequested = true; void stop(); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const output = (chunk: string) => {
        options.onOutput(chunk);
        tail = (tail + chunk).slice(-32768);
      };
      child!.stdout!.setEncoding('utf8'); child!.stderr!.setEncoding('utf8');
      child!.stdout!.on('data', output); child!.stderr!.on('data', output);
      child!.once('error', error => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener('abort', abort);
        reject(error);
      });
      child!.once('close', async exitCode => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener('abort', abort);
        await stopping;
        if (cancelRequested || options.signal.aborted) reject(new CancelledError());
        else if (exitCode === 0) resolve();
        else reject(new Error(classifyScpError(tail, exitCode ?? -1)));
      });
    });
  } catch (error) {
    if (cancelRequested || options.signal.aborted) throw new CancelledError();
    throw error;
  } finally {
    authSession.dispose();
  }
}

export function classifyScpError(output: string, exitCode: number): string {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  const rules: [RegExp, string][] = [
    [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i, 'SSH 主机指纹校验失败。请核实服务器身份并检查本机 known_hosts。'],
    [/Permission denied.*(?:publickey|password|keyboard-interactive)/i, 'SSH 认证失败。请检查密码、密钥、ssh-agent 和跳板机配置。'],
    [/Permission denied/i, '没有读写权限，请检查源文件及目标目录权限。'],
    [/No space left|disk full/i, '目标磁盘空间不足。'],
    [/No such file|not found/i, '文件或目录不存在，可能已被移动或删除。'],
    [/Connection timed out|Connection reset|Connection closed|Broken pipe|lost connection/i, 'SSH 连接中断或超时，请检查网络后从头重试。'],
    [/Could not resolve hostname/i, '无法解析 SSH 主机，请检查别名和网络。'],
    [/subsystem request failed/i, '服务器未提供 SFTP 子系统。第一版需要 OpenSSH scp 的默认 SFTP 传输支持。'],
    [/ssh_askpass.*(?:failed|No such file|Permission)/i, 'Windows askpass 辅助程序无法运行，请检查安装完整性和安全软件拦截。']
  ];
  for (const [pattern, message] of rules) if (pattern.test(text)) return `${message}（退出码 ${exitCode}，详细信息见日志）`;
  const lines = text.split(/[\r\n]/).map(line => line.trim()).filter(line => line && !/\d+%/.test(line));
  return `${lines.slice(-3).join(' ').slice(0, 700) || 'scp 传输失败'}（退出码 ${exitCode}）`;
}
