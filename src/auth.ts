import * as vscode from 'vscode';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

interface AuthRequest { token: string; prompt: string; hint: string }
interface AuthSession {
  signal: AbortSignal;
  onPrompt(): void;
  onAnswer(): void;
  onCancel(): void;
  sockets: Set<net.Socket>;
  activeSocket?: net.Socket;
  dismiss?: () => void;
}

export class AuthBroker implements vscode.Disposable {
  private readonly pipeName = `scp-fast-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  private readonly server = net.createServer(socket => this.accept(socket));
  private readonly sessions = new Map<string, AuthSession>();
  private serial: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(`\\\\.\\pipe\\${this.pipeName}`, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.server.on('error', () => this.dispose());
  }

  session(signal: AbortSignal, callbacks: Omit<AuthSession, 'signal' | 'sockets' | 'dismiss'>): { env: NodeJS.ProcessEnv; dispose(): void } {
    const token = crypto.randomBytes(32).toString('hex');
    const session: AuthSession = { signal, sockets: new Set(), ...callbacks };
    this.sessions.set(token, session);
    const dispose = () => {
      session.dismiss?.();
      for (const socket of session.sockets) socket.destroy();
      this.sessions.delete(token);
      signal.removeEventListener('abort', dispose);
    };
    signal.addEventListener('abort', dispose, { once: true });
    return { env: { SCP_FAST_AUTH_PIPE: this.pipeName, SCP_FAST_AUTH_TOKEN: token }, dispose };
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.setTimeout(10 * 60_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let buffer = '', handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 16384) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      let request: AuthRequest;
      try { request = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
      const session = this.sessions.get(request.token);
      if (!session || session.signal.aborted || typeof request.prompt !== 'string') { socket.destroy(); return; }
      session.sockets.add(socket);
      socket.once('close', () => {
        session.sockets.delete(socket);
        if (session.activeSocket === socket) session.dismiss?.();
      });
      this.serial = this.serial.then(async () => {
        if (socket.destroyed || session.signal.aborted || !this.sessions.has(request.token)) return;
        session.activeSocket = socket;
        session.onPrompt();
        const confirmation = request.hint === 'confirm' || /(?:yes\/no|fingerprint.*\?)/i.test(request.prompt);
        const answer = await this.prompt(session, request.prompt, confirmation);
        session.activeSocket = undefined;
        if (socket.destroyed) return;
        socket.end(JSON.stringify(answer === undefined ? { cancelled: true } : { value: answer }) + '\n');
        if (answer === undefined) session.onCancel(); else session.onAnswer();
      }).catch(() => { socket.destroy(); session.onCancel(); });
    });
  }

  private prompt(session: AuthSession, originalPrompt: string, confirmation: boolean): Promise<string | undefined> {
    const prompt = originalPrompt.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 4000);
    return new Promise(resolve => {
      const input = confirmation ? vscode.window.createQuickPick<{ label: string; value: string }>() : vscode.window.createInputBox();
      input.title = confirmation ? 'SCP-Fast：确认 SSH 主机或认证许可' : 'SCP-Fast：SSH 认证';
      input.ignoreFocusOut = true;
      if (confirmation) {
        const picker = input as vscode.QuickPick<{ label: string; value: string }>;
        picker.placeholder = prompt;
        picker.items = [
          { label: '拒绝连接', value: 'no' },
          { label: '确认并继续连接', value: 'yes' }
        ];
      } else {
        const box = input as vscode.InputBox;
        box.password = true;
        box.prompt = prompt;
        box.placeholder = '输入密码、密钥口令或验证码；仅用于这次认证';
      }
      let settled = false;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.dismiss = undefined;
        input.hide();
        input.dispose();
        resolve(value);
      };
      const timer = setTimeout(() => finish(), 10 * 60_000);
      session.dismiss = () => finish();
      input.onDidHide(() => finish());
      input.onDidAccept(() => {
        if (confirmation) {
          const selected = (input as vscode.QuickPick<{ label: string; value: string }>).selectedItems[0];
          finish(selected?.value === 'yes' ? 'yes' : undefined);
        } else {
          const value = (input as vscode.InputBox).value;
          if (/[\r\n\0]/.test(value)) return;
          finish(value);
        }
      });
      input.show();
    });
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dismiss?.();
      for (const socket of session.sockets) socket.destroy();
    }
    this.sessions.clear();
    this.server.close();
  }
}
