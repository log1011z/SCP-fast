import { FileInfo, TransferFiles, TransferTask, CancelledError } from './types';
import { displayTaskText, errorMessage, siblingUri, temporaryName, throwIfCancelled } from './util';
import { ScpProgress } from './progress';

export type CollisionChoice = 'overwrite' | 'skip' | 'cancelBatch';
export interface TransferHooks {
  files: TransferFiles;
  run(task: TransferTask, signal: AbortSignal, onProgress: (progress: ScpProgress) => void,
    onAuth: (waiting: boolean) => void): Promise<void>;
  collision(task: TransferTask, changed: boolean, signal: AbortSignal): Promise<CollisionChoice>;
  cancelBatch(batchId: string): void;
  changed(): void;
  log(task: TransferTask, message: string): void;
}

function unchanged(first: FileInfo | undefined, second: FileInfo | undefined): boolean {
  return first?.kind === second?.kind && first?.size === second?.size && first?.mtime === second?.mtime;
}

async function readWithTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取文件信息超时，请检查 Remote-SSH 连接。')), 20000);
      if (signal) {
        abort = () => reject(new CancelledError());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
    })]);
  } finally {
    clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

export class TransferEngine {
  constructor(private readonly hooks: TransferHooks) {}

  async execute(task: TransferTask, signal: AbortSignal): Promise<void> {
    const { files } = this.hooks;
    let completeTemporary = false;
    let timer: NodeJS.Timeout | undefined;
    let polling = false, acceptProgress = true, lastNative = 0, lastSampleBytes = 0, lastSampleAt = Date.now();
    let scpStartedAt = 0, authStartedAt = 0;
    try {
      throwIfCancelled(signal);
      const source = await readWithTimeout(files.stat(task.source), signal);
      if (!source || source.kind !== 'file') throw new Error('源文件不存在或不是普通文件；第一版不传输目录和符号链接。');
      task.totalBytes = source.size;
      let target = await readWithTimeout(files.stat(task.destination), signal);
      let overwrite = false;
      const decide = async (changed: boolean): Promise<boolean> => {
        if (target && target.kind !== 'file') throw new Error('目标是目录、符号链接或特殊文件，不能覆盖。');
        const choice = await this.hooks.collision(task, changed, signal);
        throwIfCancelled(signal);
        if (choice === 'cancelBatch') { this.hooks.cancelBatch(task.batchId); throw new CancelledError(); }
        if (choice === 'skip') { task.state = 'skipped'; return false; }
        overwrite = true;
        return true;
      };
      if (target && !await decide(false)) return;
      throwIfCancelled(signal);
      task.temporary = siblingUri(task.destination, temporaryName(task.name));
      if (await readWithTimeout(files.stat(task.temporary), signal)) throw new Error('临时文件意外存在，请重试。');
      this.hooks.changed();
      this.hooks.log(task, `开始${task.direction === 'download' ? '下载' : '上传'} ${task.name}；源大小 ${source.size} B`);
      task.state = 'transferring'; this.hooks.changed();
      task.preparationMs = Date.now() - (task.startedAt ?? Date.now());
      task.authenticationWaitMs = 0;
      scpStartedAt = Date.now();
      task.transferStartedAt = scpStartedAt;
      lastSampleAt = scpStartedAt;
      const update = (count: number, speed: number, eta?: number, estimated = false) => {
        if (!acceptProgress || signal.aborted || task.state === 'committing') return;
        if (!task.transferStartedAt) task.transferStartedAt = Date.now();
        task.state = 'transferring';
        task.transferredBytes = Math.min(source.size ? Math.max(0, source.size - 1) : 0, Math.max(task.transferredBytes, count));
        task.speed = speed;
        task.remainingSeconds = eta ?? (speed > 0 ? Math.max(0, (source.size - task.transferredBytes) / speed) : undefined);
        task.progressEstimated = estimated;
        this.hooks.changed();
      };
      timer = setInterval(() => {
        if (polling || Date.now() - lastNative < 2500 || signal.aborted || task.state !== 'transferring') return;
        polling = true;
        void readWithTimeout(files.stat(task.temporary!)).then(info => {
          if (!info || info.kind !== 'file' || Date.now() - lastNative < 2500) return;
          const now = Date.now();
          const speed = Math.max(0, info.size - lastSampleBytes) / Math.max((now - lastSampleAt) / 1000, 0.001);
          lastSampleBytes = info.size; lastSampleAt = now;
          if (info.size > 0) update(info.size, speed, undefined, true);
        }).catch(() => { /* Metadata sampling failure must not fail an active scp transfer. */ })
          .finally(() => { polling = false; });
      }, 1000);
      await this.hooks.run(task, signal, progress => {
        lastNative = Date.now();
        update(progress.bytes, progress.speed, progress.eta);
      }, waiting => {
        if (waiting) authStartedAt = Date.now();
        else if (authStartedAt) {
          task.authenticationWaitMs = (task.authenticationWaitMs ?? 0) + Date.now() - authStartedAt;
          authStartedAt = 0;
          lastSampleAt = Date.now(); lastSampleBytes = task.transferredBytes;
        }
        task.state = waiting ? 'authenticating' : 'transferring';
        this.hooks.changed();
      });
      acceptProgress = false;
      clearInterval(timer); timer = undefined;
      const finishedTransfer = Date.now();
      task.scpDurationMs = finishedTransfer - scpStartedAt;
      task.transferDurationMs = Math.max(1, task.scpDurationMs - (task.authenticationWaitMs ?? 0));
      this.hooks.log(task, `scp 已退出成功；scp 阶段 ${(task.scpDurationMs / 1000).toFixed(2)} 秒；认证输入等待 ${((task.authenticationWaitMs ?? 0) / 1000).toFixed(2)} 秒`);
      const verificationStartedAt = Date.now();
      throwIfCancelled(signal);
      const [currentSource, temporary] = await Promise.all([
        readWithTimeout(files.stat(task.source), signal), readWithTimeout(files.stat(task.temporary), signal)
      ]);
      if (!unchanged(source, currentSource)) throw new Error('传输期间源文件大小或修改时间发生变化，请等待文件写入完成后重试。');
      if (!temporary || temporary.kind !== 'file' || temporary.size !== source.size) throw new Error('传输后的临时文件大小不匹配，未替换正式文件。');
      completeTemporary = true;
      const latestTarget = await readWithTimeout(files.stat(task.destination), signal);
      if (!unchanged(target, latestTarget)) {
        target = latestTarget;
        overwrite = false;
        if (target && !await decide(true)) {
          completeTemporary = false;
          return;
        }
      }
      throwIfCancelled(signal);
      task.verificationMs = Date.now() - verificationStartedAt;
      task.state = 'committing'; this.hooks.changed();
      // Committing is intentionally not cancellable: wait for the rename outcome.
      const commitStartedAt = Date.now();
      await files.rename(task.temporary, task.destination, overwrite);
      task.commitMs = Date.now() - commitStartedAt;
      task.temporary = undefined;
      task.state = 'success'; task.transferredBytes = source.size;
      task.remainingSeconds = 0; task.progressEstimated = false;
      this.hooks.log(task, `正式文件已提交：${task.destination}`);
      this.hooks.log(task, `分段耗时：准备 ${((task.preparationMs ?? 0) / 1000).toFixed(2)} 秒；校验 ${(task.verificationMs / 1000).toFixed(2)} 秒；提交 ${(task.commitMs / 1000).toFixed(2)} 秒`);
    } catch (error) {
      if (authStartedAt) task.authenticationWaitMs = (task.authenticationWaitMs ?? 0) + Date.now() - authStartedAt;
      if (scpStartedAt && task.scpDurationMs === undefined) task.scpDurationMs = Date.now() - scpStartedAt;
      if (error instanceof Error) error.message = displayTaskText(task, error.message);
      this.hooks.log(task, `任务失败或取消：${displayTaskText(task, errorMessage(error))}`);
      throw error;
    } finally {
      acceptProgress = false;
      clearInterval(timer);
      if (task.temporary && !completeTemporary) {
        try {
          // Only this task's unique sibling temporary file is ever removed.
          if (await readWithTimeout(files.stat(task.temporary))) await readWithTimeout(files.remove(task.temporary));
          task.temporary = undefined;
        } catch (error) {
          task.cleanupError = `临时文件清理失败：${errorMessage(error)}`;
          this.hooks.log(task, `${task.cleanupError}；位置 ${task.temporary}`);
        }
      } else if (task.temporary) {
        this.hooks.log(task, `完整临时文件已保留，可手动取回：${task.temporary}`);
      }
    }
  }
}
