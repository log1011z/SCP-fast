export interface ScpProgress { bytes: number; percent: number; speed: number; eta?: number }

function unitBytes(value: number, suffix: string): number {
  const index = 'BKMGTP'.indexOf((suffix || 'B').toUpperCase());
  return value * 1024 ** Math.max(index, 0);
}

export class ProgressParser {
  private buffer = '';
  feed(chunk: string): ScpProgress[] {
    this.buffer += chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    if (this.buffer.length > 32768) this.buffer = this.buffer.slice(-16384);
    const lines = this.buffer.split(/[\r\n]/);
    this.buffer = lines.pop() ?? '';
    // ConPTY can send a fully formed progress line without a trailing CR yet.
    const partial = this.parse(this.buffer);
    const result = lines.map(line => this.parse(line)).filter((item): item is ScpProgress => !!item);
    if (partial) { result.push(partial); this.buffer = ''; }
    return result;
  }
  private parse(line: string): ScpProgress | undefined {
    const match = /(?:^|\s)(\d{1,3})%\s+(\d+(?:\.\d+)?)\s*([BKMGTP])?(?:i?B)?\s+(\d+(?:\.\d+)?)\s*([BKMGTP])?(?:i?B)?\/s\s+(?:(\d+):(\d+)(?::(\d+))?|--:--|stalled)/i.exec(line);
    if (!match) return undefined;
    const percent = Number(match[1]);
    if (percent > 100) return undefined;
    const eta = match[6] === undefined ? undefined : match[8] === undefined
      ? Number(match[6]) * 60 + Number(match[7]) : Number(match[6]) * 3600 + Number(match[7]) * 60 + Number(match[8]);
    return { percent, bytes: unitBytes(Number(match[2]), match[3] ?? ''), speed: unitBytes(Number(match[4]), match[5] ?? ''), eta };
  }
}
