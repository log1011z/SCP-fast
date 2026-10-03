import { randomUUID } from 'node:crypto';
import { CancelledError, TransferTask, terminalStates } from './types';
import { errorMessage } from './util';

export type TaskSeed = Pick<TransferTask, 'direction' | 'host' | 'source' | 'destination' | 'name'> &
  Partial<Pick<TransferTask, 'kind' | 'localRoot' | 'folderRoot'>>;

export class TransferQueue {
  readonly tasks: TransferTask[] = [];
  private current?: { task: TransferTask; controller: AbortController };
  private work?: Promise<void>;
  private disposed = false;
  constructor(private readonly execute: (task: TransferTask, signal: AbortSignal) => Promise<void>,
    private readonly changed: () => void, private readonly finished: (task: TransferTask) => Promise<void>) {}

  restore(history: TransferTask[]): void {
    const pending = history.filter(value => value && !terminalStates.has(value.state));
    const ended = history.filter(value => value && terminalStates.has(value.state)).slice(-100);
    for (const value of [...ended, ...pending]) {
      if (!value || typeof value.id !== 'string' || !value.host || !value.source || !value.destination) continue;
      const task = { ...value };
      if (!terminalStates.has(task.state)) {
        task.state = 'interrupted'; task.finishedAt = Date.now();
        task.error = '窗口关闭或扩展重载导致任务中断；可从头重试。';
      }
      this.tasks.push(task);
    }
    this.changed();
  }

  enqueue(seeds: TaskSeed[]): TransferTask[] {
    if (this.disposed) throw new Error('传输队列已经关闭');
    const batchId = randomUUID();
    const created = seeds.map(seed => ({ direction: seed.direction, source: seed.source,
      destination: seed.destination, name: seed.name, kind: seed.kind, localRoot: seed.localRoot,
      folderRoot: seed.folderRoot, host: { ...seed.host }, id: randomUUID(), batchId,
      state: 'queued' as const, totalBytes: 0, transferredBytes: 0, speed: 0,
      progressEstimated: false, createdAt: Date.now() }));
    this.tasks.push(...created);
    this.changed();
    this.start();
    return created;
  }

  private start(): void {
    if (this.work || this.disposed) return;
    this.work = Promise.resolve().then(() => this.drain()).finally(() => {
      this.work = undefined;
      if (this.tasks.some(task => task.state === 'queued')) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      const task = this.tasks.find(item => item.state === 'queued');
      if (!task) break;
      const controller = new AbortController();
      this.current = { task, controller };
      task.startedAt = Date.now(); task.state = 'preparing'; this.changed();
      try {
        await this.execute(task, controller.signal);
      } catch (error) {
        task.state = error instanceof CancelledError || controller.signal.aborted ? 'cancelled' : 'failed';
        task.error = errorMessage(error);
      } finally {
        if (!terminalStates.has(task.state)) { task.state = 'failed'; task.error = '任务未正确结束，请查看日志。'; }
        task.finishedAt = Date.now(); this.current = undefined;
        this.changed();
        try { await this.finished(task); } catch { /* A notification must never stop the queue. */ }
      }
    }
  }

  update(): void { this.changed(); }

  cancel(taskId?: string): void {
    const task = taskId ? this.tasks.find(value => value.id === taskId) : this.current?.task;
    if (!task || terminalStates.has(task.state) || task.state === 'committing') return;
    if (this.current?.task === task) this.current.controller.abort();
    else { task.state = 'cancelled'; task.finishedAt = Date.now(); }
    this.changed();
  }

  cancelBatch(batchId: string): void {
    for (const task of this.tasks) {
      if (task.batchId !== batchId || terminalStates.has(task.state) || task.state === 'committing') continue;
      if (this.current?.task === task) this.current.controller.abort();
      else { task.state = 'cancelled'; task.finishedAt = Date.now(); }
    }
    this.changed();
  }

  private descendant(task: TransferTask, parent: TransferTask): boolean {
    if (task.batchId !== parent.batchId || task.id === parent.id) return false;
    const root = new URL(parent.destination), child = new URL(task.destination);
    return root.protocol === child.protocol && root.host === child.host &&
      child.pathname.toLowerCase().startsWith(root.pathname.replace(/\/$/, '').toLowerCase() + '/');
  }

  cancelDescendants(parent: TransferTask): void {
    for (const task of this.tasks) {
      if (task.state !== 'queued' || !this.descendant(task, parent)) continue;
      task.state = 'cancelled'; task.finishedAt = Date.now();
    }
    this.changed();
  }

  retry(taskId: string): TransferTask[] {
    const previous = this.tasks.find(task => task.id === taskId);
    if (!previous || !['failed', 'cancelled', 'interrupted'].includes(previous.state)) return [];
    const seeds = previous.kind === 'directory' ? this.tasks.filter(task =>
      (task === previous || this.descendant(task, previous)) && ['failed', 'cancelled', 'interrupted'].includes(task.state)) : [previous];
    return this.enqueue(seeds);
  }

  clearFinished(): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (terminalStates.has(this.tasks[i].state) && !this.tasks[i].temporary) this.tasks.splice(i, 1);
    }
    this.changed();
  }

  get active(): TransferTask | undefined { return this.current?.task; }
  get waiting(): number { return this.tasks.filter(task => task.state === 'queued').length; }

  async stop(): Promise<void> {
    this.disposed = true;
    this.current?.controller.abort();
    await this.work;
  }
}
