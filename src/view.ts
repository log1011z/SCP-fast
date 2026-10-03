import * as vscode from 'vscode';
import { TransferQueue } from './queue';
import { TransferTask, TaskState, terminalStates } from './types';
import { bytes, displayPath, displayTaskText } from './util';

function remainingTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 60) return '即将完成';
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${Math.ceil(seconds / 3600)} 小时`;
}

export const stateNames: Record<TaskState, string> = {
  queued: '等待', preparing: '准备中', authenticating: '等待 SSH 认证', transferring: '传输中',
  committing: '正在提交', success: '成功', failed: '失败', cancelled: '已取消', skipped: '已跳过', interrupted: '已中断'
};

export class TransferView implements vscode.TreeDataProvider<TransferTask>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TransferTask | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 35);
  private timer?: NodeJS.Timeout;
  private dirty = false;
  constructor(private readonly queue: TransferQueue) {
    this.status.command = 'scpFast.showQueue';
    this.status.name = 'SCP-Fast 传输';
  }
  update(): void {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false; this.emitter.fire(undefined); this.updateStatus();
    }, 500);
  }
  getTreeItem(task: TransferTask): vscode.TreeItem {
    const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.None);
    item.id = task.id;
    const percent = task.totalBytes ? Math.min(task.state === 'success' ? 100 : 99, Math.floor(task.transferredBytes / task.totalBytes * 100)) : task.state === 'success' ? 100 : 0;
    const direction = task.direction === 'download' ? '↓ 下载' : '↑ 上传';
    if (task.state === 'transferring') {
      item.description = `${direction} · ${task.progressEstimated ? '估算 ' : ''}${percent}% · ${bytes(task.transferredBytes)} / ${bytes(task.totalBytes)} · ${bytes(task.speed)}/s · 剩余 ${remainingTime(task.remainingSeconds)}`;
    } else if (task.state === 'success' && task.kind === 'directory') {
      item.description = `${direction} · 文件夹已准备`;
    } else if (task.state === 'success') {
      const elapsed = Math.max(0.001, (task.transferDurationMs ?? 0) / 1000);
      item.description = `${direction} · 成功 · ${bytes(task.totalBytes)} · 平均 ${bytes(task.totalBytes / elapsed)}/s`;
    } else { item.description = `${direction} · ${task.host.alias} · ${stateNames[task.state]}`; }
    item.tooltip = `${task.name}\n${direction} · ${task.host.alias}\n${stateNames[task.state]}\n源：${displayPath(task.source)}\n目标：${displayPath(task.destination)}` +
      `${task.error ? `\n原因：${displayTaskText(task, task.error)}` : ''}${task.cleanupError ? `\n${displayTaskText(task, task.cleanupError)}` : ''}${task.temporary ? '\n保留临时文件：位置见任务日志' : ''}`;
    if (task.state === 'success') {
      item.iconPath = new vscode.ThemeIcon(task.kind === 'directory' ? 'folder' : 'pass', new vscode.ThemeColor('testing.iconPassed'));
      item.contextValue = task.direction === 'download' ? 'scpFast.downloaded' : 'scpFast.finished';
    } else if (['failed', 'cancelled', 'interrupted'].includes(task.state)) {
      item.iconPath = new vscode.ThemeIcon(task.state === 'failed' ? 'error' : 'circle-slash', new vscode.ThemeColor('testing.iconFailed'));
      item.contextValue = 'scpFast.retryable';
    } else if (task.state === 'skipped') {
      item.iconPath = new vscode.ThemeIcon('debug-step-over'); item.contextValue = 'scpFast.finished';
    } else {
      item.iconPath = new vscode.ThemeIcon(task.state === 'queued' ? 'clock' : task.state === 'authenticating' ? 'key' : 'sync~spin');
      item.contextValue = task.state === 'committing' ? 'scpFast.committing' : 'scpFast.active';
    }
    item.command = { command: 'scpFast.showLog', title: '查看任务日志', arguments: [task] };
    return item;
  }
  getChildren(): TransferTask[] {
    return [...this.queue.tasks.filter(task => !terminalStates.has(task.state)),
      ...this.queue.tasks.filter(task => terminalStates.has(task.state)).slice(-100).reverse()];
  }
  private updateStatus(): void {
    const task = this.queue.active;
    if (task) {
      const percent = task.totalBytes ? Math.min(99, Math.floor(task.transferredBytes / task.totalBytes * 100)) : 0;
      this.status.text = `$(sync~spin) SCP ${task.direction === 'download' ? '↓' : '↑'} ${task.state === 'transferring' ? `${percent}%` : stateNames[task.state]}${this.queue.waiting ? ` · ${this.queue.waiting} 等待` : ''}`;
      this.status.tooltip = `${task.name}\n${bytes(task.speed)}/s\n点击查看传输队列`;
    } else {
      const failures = this.queue.tasks.filter(task => ['failed', 'interrupted'].includes(task.state)).length;
      this.status.text = failures ? `$(warning) SCP-Fast · ${failures} 失败/中断` : '$(check) SCP-Fast';
      this.status.tooltip = '点击查看传输队列';
    }
    if (this.queue.tasks.length) this.status.show(); else this.status.hide();
  }
  dispose(): void { clearTimeout(this.timer); this.emitter.dispose(); this.status.dispose(); }
}
