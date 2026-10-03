import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HostProfile } from './types';
import { assertAlias, expandHome, hostFromAuthority } from './util';
import { readAliases, parseEffectiveConfig } from './sshConfig';
import { runPlain } from './process';

function localSetting<T>(section: string, key: string): T | undefined {
  const inspect = vscode.workspace.getConfiguration(section).inspect<T>(key);
  // A remote workspace must not choose local executables or SSH configuration files.
  return inspect?.globalValue ?? inspect?.defaultValue;
}

async function executable(configured: string | undefined, defaultValue: string): Promise<string> {
  const expanded = expandHome(configured || defaultValue);
  if (path.isAbsolute(expanded)) {
    await fs.access(expanded);
    return expanded;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), expanded.endsWith('.exe') ? expanded : `${expanded}.exe`);
    try { await fs.access(candidate); return candidate; } catch { /* Continue PATH search. */ }
  }
  throw new Error(`找不到本机程序：${expanded}。请安装 Windows OpenSSH 客户端或设置绝对路径。`);
}

export class HostResolver {
  private verified = new Set<string>();
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolve(authority: string, forceSelect = false): Promise<HostProfile | undefined> {
    const remoteHost = hostFromAuthority(authority);
    const defaultSsh = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32/OpenSSH/ssh.exe');
    const sshPath = await executable(localSetting<string>('scpFast', 'sshPath') || localSetting<string>('remote.SSH', 'path'), defaultSsh);
    const scpPath = await executable(localSetting<string>('scpFast', 'scpPath'), path.join(path.dirname(sshPath), 'scp.exe'));
    const configured = localSetting<string>('scpFast', 'sshConfigPath') || localSetting<string>('remote.SSH', 'configFile');
    const configPath = expandHome(configured || path.join(os.homedir(), '.ssh/config'));
    let configExists = true;
    try { await fs.access(configPath); } catch {
      if (configured) throw new Error(`本机 SSH 配置文件不存在或无法访问：${configPath}`);
      configExists = false;
    }
    const signature = `${sshPath}|${scpPath}`;
    if (!this.verified.has(signature)) {
      const version = await runPlain(sshPath, ['-V']);
      const match = /OpenSSH(?:_for_Windows)?[_ ](\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) < 9) throw new Error('第一版需要 Windows OpenSSH 9.0 或更新版本，以支持默认 SFTP 文件传输。');
      this.verified.add(signature);
    }
    const aliases = configExists ? await readAliases(configPath, path.join(os.homedir(), '.ssh')) : [];
    // The system config is read by OpenSSH too; enumerate concrete aliases there as a fallback.
    for (const alias of await readAliases(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh/ssh_config'))) {
      if (!aliases.includes(alias)) aliases.push(alias);
    }
    const mappings = this.context.globalState.get<Record<string, string>>('scpFast.hostMappings', {});
    const key = `${authority}|${configPath}`;
    let alias = !forceSelect ? mappings[key] : undefined;
    if (alias && !aliases.includes(alias) && alias !== remoteHost) alias = undefined;
    if (!alias && !forceSelect) alias = aliases.find(candidate => candidate.toLowerCase() === remoteHost.toLowerCase());
    if (!alias) {
      if (!aliases.length) throw new Error('未找到具体 SSH Host 条目。请在本机 ~/.ssh/config 添加 Host 别名，再使用 SCP-Fast。');
      const selected = await vscode.window.showQuickPick(aliases.map(value => ({ label: value })), {
        title: `SCP-Fast：为 ${remoteHost} 选择已有 SSH 条目`,
        placeHolder: '选择与当前 Remote-SSH 服务器相同的主机、用户和端口', ignoreFocusOut: true
      });
      if (!selected) return undefined;
      alias = selected.label;
    }
    assertAlias(alias);
    const options = configExists ? ['-F', configPath] : [];
    const effective = parseEffectiveConfig(await runPlain(sshPath, [...options, '-G', alias]));
    // Resolve the Remote-SSH identifier separately to guard against a mistaken manual mapping.
    let expected: ReturnType<typeof parseEffectiveConfig> | undefined;
    try {
      assertAlias(remoteHost);
      expected = parseEffectiveConfig(await runPlain(sshPath, [...options, '-G', remoteHost]));
    } catch { /* Encoded/direct authorities can require a manual mapping. */ }
    if (expected && (effective.hostname.toLowerCase() !== expected.hostname.toLowerCase() || effective.port !== expected.port || effective.user !== expected.user)) {
      const answer = await vscode.window.showWarningMessage(
        `所选 SSH 条目 ${alias} (${effective.user}@${effective.hostname}:${effective.port}) 与当前连接标识解析结果不同。`,
        { modal: true, detail: '仅在确认它连接到同一服务器、同一用户时继续，否则服务器路径可能指向其他文件。' }, '确认是同一连接');
      if (answer !== '确认是同一连接') return undefined;
    }
    mappings[key] = alias;
    await this.context.globalState.update('scpFast.hostMappings', mappings);
    return { authority, alias, sshPath, scpPath, configPath: configExists ? configPath : undefined,
      hostname: effective.hostname, user: effective.user, port: effective.port };
  }
}
