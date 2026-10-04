/**
 * Clipboard cleanup for an explicitly revealed secret. Nothing is persisted or
 * sent to a background worker. Timers retain a digest, never the copied secret.
 * Closing a browser popup can interrupt cleanup; explicit clearing is the only
 * operation whose success the still-open UI can report to the user.
 */
export type SecretClipboardStatus = 'idle' | 'copied' | 'cleared' | 'replaced' | 'unavailable';

type ClipboardAccess = Pick<Clipboard, 'readText' | 'writeText'>;

async function fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}

export class SecretClipboard {
  private copiedFingerprint: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private revision = 0;
  private clearing: { revision: number; result: Promise<SecretClipboardStatus> } | null = null;

  constructor(
    private readonly clipboard: ClipboardAccess,
    private readonly onStatus: (status: SecretClipboardStatus) => void,
    private readonly ttlMs = 10_000,
  ) {}

  private emit(status: SecretClipboardStatus): SecretClipboardStatus {
    if (!this.disposed) this.onStatus(status);
    return status;
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  async copy(secret: string): Promise<void> {
    const digest = await fingerprint(secret);
    if (this.disposed) throw new Error('the secret view closed before copying');
    await this.clipboard.writeText(secret);
    this.stopTimer();
    this.revision++;
    this.copiedFingerprint = digest;
    if (this.disposed) {
      await this.clearIfUnchanged();
      return;
    }
    this.emit('copied');
    this.timer = setTimeout(() => { void this.clearIfUnchanged(); }, this.ttlMs);
  }

  /** User-requested clearing needs no clipboard read permission. */
  async clear(): Promise<SecretClipboardStatus> {
    this.stopTimer();
    const revision = ++this.revision;
    try {
      await this.clipboard.writeText('');
      if (revision !== this.revision) return 'idle';
      this.copiedFingerprint = null;
      return this.emit('cleared');
    } catch {
      return this.emit('unavailable');
    }
  }

  /** Timer and lifecycle clearing must preserve anything copied afterward. */
  clearIfUnchanged(): Promise<SecretClipboardStatus> {
    if (this.clearing?.revision === this.revision) return this.clearing.result;
    const run = { revision: this.revision, result: this.clearMatching() };
    this.clearing = run;
    void run.result.finally(() => { if (this.clearing === run) this.clearing = null; });
    return run.result;
  }

  private async clearMatching(): Promise<SecretClipboardStatus> {
    const expected = this.copiedFingerprint;
    if (!expected) return 'idle';
    const revision = this.revision;
    try {
      const current = await this.clipboard.readText();
      const actual = await fingerprint(current);
      if (revision !== this.revision) return 'idle';
      if (actual !== expected) {
        this.stopTimer();
        this.copiedFingerprint = null;
        return this.emit('replaced');
      }
      await this.clipboard.writeText('');
      if (revision !== this.revision) return 'idle';
      this.stopTimer();
      this.copiedFingerprint = null;
      return this.emit('cleared');
    } catch {
      return this.emit('unavailable');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopTimer();
    await this.clearIfUnchanged();
  }
}
