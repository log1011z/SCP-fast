import { TransferTask, terminalStates } from './types';

/** A selection of a folder is one record, even when its contents run separately. */
export function transferRecords(tasks: TransferTask[]): TransferTask[] {
  const groups = new Map<string, TransferTask[]>();
  for (const task of tasks) {
    const key = task.folderRoot ? JSON.stringify([task.batchId, task.folderRoot]) : task.id;
    const group = groups.get(key);
    if (group) group.push(task); else groups.set(key, [task]);
  }
  return [...groups.values()].map(members => {
    const first = members[0];
    if (!first.folderRoot) return first;
    const root = members.find(task => task.destination === first.folderRoot) ?? first;
    const files = members.filter(task => task.kind !== 'directory');
    const pending = members.filter(task => !terminalStates.has(task.state));
    const active = pending.find(task => task.state !== 'queued');
    const failed = members.find(task => task.state === 'failed');
    const interrupted = members.find(task => task.state === 'interrupted');
    const cancelled = members.find(task => task.state === 'cancelled');
    const completedFiles = files.filter(task => terminalStates.has(task.state)).length;
    const skippedFiles = files.filter(task => task.state === 'skipped').length;
    const state = active?.state ?? (pending.length ? (members.some(task => task.startedAt) ? 'preparing' : 'queued') :
      failed ? 'failed' : interrupted ? 'interrupted' : cancelled ? 'cancelled' :
        files.length && skippedFiles === files.length ? 'skipped' : 'success');
    const fraction = active?.kind !== 'directory' && active?.totalBytes ?
      Math.min(0.99, active.transferredBytes / active.totalBytes) : 0;
    const started = members.map(task => task.startedAt).filter((value): value is number => value !== undefined);
    // Old releases could truncate the root from history. Reconstruct its readable path.
    const destination = first.folderRoot;
    const source = new URL(root.source);
    const removed = new URL(root.destination).pathname.slice(new URL(destination).pathname.length);
    if (removed) source.pathname = source.pathname.slice(0, -removed.length);
    const name = decodeURIComponent(new URL(destination).pathname.split('/').filter(Boolean).pop()!);
    return { ...root, source: source.toString(), destination, name, kind: 'directory', members,
      state, fileCount: files.length, completedFiles, skippedFiles,
      progressPercent: files.length ? Math.min(pending.length ? 99 : 100, (completedFiles + fraction) / files.length * 100) : pending.length ? 0 : 100,
      totalBytes: files.reduce((sum, task) => sum + task.totalBytes, 0),
      transferredBytes: files.reduce((sum, task) => sum + task.transferredBytes, 0),
      speed: active?.speed ?? 0, remainingSeconds: undefined, progressEstimated: true,
      startedAt: started.length ? started.reduce((earliest, value) => Math.min(earliest, value)) : undefined,
      finishedAt: pending.length ? undefined : members.reduce((latest, task) => Math.max(latest, task.finishedAt ?? 0), 0),
      transferDurationMs: files.reduce((sum, task) => sum + (task.transferDurationMs ?? 0), 0),
      error: (failed ?? interrupted ?? cancelled)?.error,
      cleanupError: members.find(task => task.cleanupError)?.cleanupError,
      temporary: members.find(task => task.temporary)?.temporary,
      logPath: root.logPath ?? members.find(task => task.logPath)?.logPath
    };
  });
}
