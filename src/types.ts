export type Direction = 'download' | 'upload';
export type TaskState = 'queued' | 'preparing' | 'authenticating' | 'transferring' | 'committing' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'interrupted';

export interface HostProfile {
  authority: string;
  alias: string;
  sshPath: string;
  scpPath: string;
  configPath?: string;
  // Used to ensure a saved/manual mapping points at the selected Remote-SSH host.
  hostname: string;
  user: string;
  port: number;
}

export interface TransferTask {
  id: string;
  batchId: string;
  direction: Direction;
  host: HostProfile;
  source: string;
  destination: string;
  name: string;
  state: TaskState;
  totalBytes: number;
  transferredBytes: number;
  speed: number;
  remainingSeconds?: number;
  progressEstimated: boolean;
  createdAt: number;
  startedAt?: number;
  transferStartedAt?: number;
  finishedAt?: number;
  transferDurationMs?: number;
  preparationMs?: number;
  authenticationWaitMs?: number;
  scpDurationMs?: number;
  verificationMs?: number;
  commitMs?: number;
  temporary?: string;
  error?: string;
  cleanupError?: string;
  logPath?: string;
}

export interface FileInfo {
  size: number;
  mtime: number;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface TransferFiles {
  stat(uri: string): Promise<FileInfo | undefined>;
  rename(source: string, destination: string, overwrite: boolean): Promise<void>;
  remove(uri: string): Promise<void>;
}

export const terminalStates = new Set<TaskState>(['success', 'failed', 'cancelled', 'skipped', 'interrupted']);

export class CancelledError extends Error {
  constructor() { super('任务已取消'); this.name = 'CancelledError'; }
}
