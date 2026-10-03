import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { expandHome } from './util';

function tokens(line: string): string[] {
  const output: string[] = [];
  let current = '', quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (!quote && char === '#') break;
    if (char === '"' || char === "'") {
      if (!quote) { quote = char; continue; }
      if (quote === char) { quote = ''; continue; }
    }
    if (!quote && /\s/.test(char)) {
      if (current) { output.push(current); current = ''; }
    } else { current += char; }
  }
  if (current) output.push(current);
  return output;
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function expandGlob(pattern: string): Promise<string[]> {
  const resolved = path.resolve(expandHome(pattern));
  if (!/[\*?]/.test(resolved)) return [resolved];
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep);
  let candidates = [parsed.root];
  for (const part of parts) {
    const next: string[] = [];
    for (const parent of candidates) {
      if (!/[\*?]/.test(part)) { next.push(path.join(parent, part)); continue; }
      try {
        const matcher = globRegex(part);
        for (const entry of await fs.readdir(parent)) {
          if (matcher.test(entry)) next.push(path.join(parent, entry));
        }
      } catch { /* Missing include directories are legal in OpenSSH. */ }
    }
    candidates = next;
  }
  return candidates.sort();
}

/** Enumerate concrete aliases only. OpenSSH remains responsible for configuration evaluation. */
export async function readAliases(configPath: string, sshDirectory = path.dirname(configPath)): Promise<string[]> {
  const seen = new Set<string>();
  const aliases = new Set<string>();
  async function visit(file: string, depth: number): Promise<void> {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || depth > 20) return;
    seen.add(key);
    let contents: string;
    try { contents = await fs.readFile(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of contents.split(/\r?\n/)) {
      // Accept both "Host alias" and "Host=alias".
      const values = tokens(line.replace(/^\s*([\w]+)\s*=\s*/, '$1 '));
      const keyword = values.shift()?.toLowerCase();
      if (keyword === 'host') {
        for (const alias of values) if (!/[!*?\[\]\s]/.test(alias)) aliases.add(alias);
      } else if (keyword === 'include') {
        for (const include of values) {
          // OpenSSH user-config relative includes are relative to ~/.ssh, not the included file.
          const pattern = path.isAbsolute(expandHome(include)) ? expandHome(include) : path.join(sshDirectory, include);
          for (const included of await expandGlob(pattern)) await visit(included, depth + 1);
        }
      }
    }
  }
  await visit(configPath, 0);
  return [...aliases].sort((a, b) => a.localeCompare(b));
}

export function parseEffectiveConfig(output: string): { hostname: string; user: string; port: number; proxyjump?: string } {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf(' ');
    if (split > 0 && !values.has(line.slice(0, split))) values.set(line.slice(0, split), line.slice(split + 1).trim());
  }
  const hostname = values.get('hostname'), user = values.get('user'), port = Number(values.get('port'));
  if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('无法解析 ssh -G 的连接配置，请检查本机 SSH 配置。');
  }
  return { hostname, user, port, proxyjump: values.get('proxyjump') };
}
