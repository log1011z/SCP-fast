import * as vscode from 'vscode';
import { createWriteStream, WriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TransferTask } from './types';
import { displayTaskText } from './util';

interface LogEntry { stream: WriteStream; size: number; truncated: boolean }

export class TransferLog implements vscode.Disposable, vscode.TextDocumentContentProvider {
  readonly channel = vscode.window.createOutputChannel('SCP-Fast');
  private readonly entries = new Map<string, LogEntry>();
  private readonly displayed = new Map<string, { task: TransferTask; uri: vscode.Uri }>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private refreshTimer?: NodeJS.Timeout;
  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    // Keep the most recent 100 logs; never touch anything outside this extension's log directory.
    const names = (await fs.readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.log$/.test(name));
    const entries = await Promise.all(names.map(async name => ({ name, mtime: (await fs.stat(path.join(this.directory, name))).mtimeMs })));
    entries.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(entries.slice(100).map(entry => fs.unlink(path.join(this.directory, entry.name)).catch(() => {})));
  }

  async open(task: TransferTask): Promise<void> {
    task.logPath = path.join(this.directory, `${task.id}.log`);
    const stream = createWriteStream(task.logPath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', error => this.channel.appendLine(`日志写入失败：${error.message}`));
    this.entries.set(task.id, { stream, size: 0, truncated: false });
    this.write(task, `文件 ${task.name}\n服务器 ${task.host.alias} (${task.host.user}@${task.host.hostname}:${task.host.port})\n源 ${task.source}\n目标 ${task.destination}`);
  }

  write(task: TransferTask, message: string): void {
    const line = `[${new Date().toISOString()}] [${task.name}] ${displayTaskText(task, message)}\n`;
    this.append(task, line);
    this.channel.append(line);
  }

  output(task: TransferTask, chunk: string): void {
    const clean = chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '\n');
    this.append(task, displayTaskText(task, clean));
    // The output channel contains summaries; full scp output stays in the per-task log.
  }

  private append(task: TransferTask, value: string): void {
    const entry = this.entries.get(task.id);
    if (!entry || entry.stream.destroyed || entry.truncated) return;
    const available = 2 * 1024 * 1024 - entry.size;
    const buffer = Buffer.from(value, 'utf8');
    if (buffer.length > available) {
      entry.stream.write(buffer.subarray(0, available));
      entry.stream.write('\n[日志达到 2 MB 上限，后续原始输出不再记录]\n');
      entry.truncated = true;
    } else { entry.stream.write(buffer); entry.size += buffer.length; }
    if (!this.refreshTimer && this.displayed.has(task.id)) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        for (const { uri } of this.displayed.values()) this.emitter.fire(uri);
      }, 1000);
    }
  }

  async close(task: TransferTask): Promise<void> {
    const entry = this.entries.get(task.id);
    if (!entry) return;
    this.entries.delete(task.id);
    if (entry.stream.destroyed) return;
    await new Promise<void>(resolve => {
      entry.stream.once('error', () => resolve());
      entry.stream.end(() => resolve());
    });
    const shown = this.displayed.get(task.id);
    if (shown) this.emitter.fire(shown.uri);
  }

  async show(task?: TransferTask): Promise<void> {
    if (task?.logPath && path.dirname(task.logPath) === this.directory) {
      try {
        const uri = vscode.Uri.from({ scheme: 'scp-fast-log', path: `/${task.name}.log`, query: task.id });
        this.displayed.set(task.id, { task, uri });
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      } catch { /* Old task logs can have been rotated. */ }
    }
    this.channel.show(true);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const task = this.displayed.get(uri.query)?.task;
    if (!task?.logPath || path.dirname(task.logPath) !== this.directory) return '任务日志不存在或已清理。';
    return displayTaskText(task, await fs.readFile(task.logPath, 'utf8'));
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const entry of this.entries.values()) entry.stream.end();
    this.entries.clear();
    this.channel.dispose();
    this.emitter.dispose();
  }
}
