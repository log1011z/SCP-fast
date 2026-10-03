import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { FileInfo, TransferFiles } from './types';

export class VscodeTransferFiles implements TransferFiles {
  async stat(value: string): Promise<FileInfo | undefined> {
    const uri = vscode.Uri.parse(value);
    try {
      if (uri.scheme === 'file') {
        const info = await fs.lstat(uri.fsPath);
        return { size: info.size, mtime: info.mtimeMs,
          kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' };
      }
      const info = await vscode.workspace.fs.stat(uri);
      return { size: info.size, mtime: info.mtime,
        kind: info.type & vscode.FileType.SymbolicLink ? 'symlink' : info.type & vscode.FileType.File ? 'file' : info.type & vscode.FileType.Directory ? 'directory' : 'other' };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'FileNotFound') return undefined;
      throw error;
    }
  }
  async rename(source: string, destination: string, overwrite: boolean): Promise<void> {
    const from = vscode.Uri.parse(source), to = vscode.Uri.parse(destination);
    if (from.scheme === 'file') {
      // fs.rename replaces a regular file without unlinking it first on Windows.
      if (!overwrite && await this.stat(destination)) throw vscode.FileSystemError.FileExists(to);
      await fs.rename(from.fsPath, to.fsPath);
    } else {
      await vscode.workspace.fs.rename(from, to, { overwrite });
    }
  }
  async remove(value: string): Promise<void> {
    const uri = vscode.Uri.parse(value);
    if (uri.scheme === 'file') await fs.unlink(uri.fsPath);
    else await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  }
}
