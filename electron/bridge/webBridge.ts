import { BrowserWindow, type Session } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeDiagnosis } from '../../shared/types';
import { prepareImage } from './imageUtil';
import { CLAUDE_NEW, COMPLETION_URL_PATTERNS, LIMIT_PATTERNS, SELECTORS } from './selectors';
import { BridgeError, type BridgeMessage, type BridgeResult, type ClaudeBridge } from './types';

interface PageState {
  streaming: boolean;
  text: string;
  codeBlocks: string[];
  count: number;
  url: string;
  error: { kind: 'rate_limit' | 'error'; text: string } | null;
}

interface PageInfo {
  url: string;
  path: string;
  onLogin: boolean;
  hasEditor: boolean;
  ready: boolean;
}

const RESPONSE_TIMEOUT_MS = 4 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the user's logged-in claude.ai session (persistent partition) from a hidden window:
 *   DOM    – attach screenshot, type the prompt, press send, read the reply
 *   Network – watch the streaming /completion request so we know exactly when a reply finished
 *             and can surface 429 / 401 / 403 as proper errors.
 * No API key and no Anthropic SDK are involved anywhere.
 */
export class WebBridge implements ClaudeBridge {
  readonly kind = 'web' as const;
  private win: BrowserWindow | null = null;
  private pageScript: string | null = null;
  private completion: { status: number; at: number } | null = null;
  /** Read through a method: TS cannot see that the webRequest callback mutates the field mid-loop. */
  private lastCompletion(): { status: number; at: number } | null {
    return this.completion;
  }
  private hooked = new WeakSet<Session>();

  constructor(
    private readonly partition: string,
    private readonly userAgent: string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  // ---------------------------------------------------------------- window
  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: this.partition,
        backgroundThrottling: false, // hidden window must keep running timers/streams at full speed
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.webContents.setUserAgent(this.userAgent);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.hookNetwork(win.webContents.session);
    win.on('closed', () => {
      this.win = null;
    });
    this.win = win;
    return win;
  }

  private hookNetwork(ses: Session): void {
    if (this.hooked.has(ses)) return;
    this.hooked.add(ses);
    ses.webRequest.onCompleted({ urls: COMPLETION_URL_PATTERNS }, (d) => {
      this.completion = { status: d.statusCode, at: Date.now() };
      this.log(`completion request finished: HTTP ${d.statusCode}`);
    });
    ses.webRequest.onErrorOccurred({ urls: COMPLETION_URL_PATTERNS }, (d) => {
      this.log(`completion request error: ${d.error}`);
    });
  }

  private async run<T>(js: string, timeoutMs = 60_000): Promise<T> {
    const win = this.window();
    return await Promise.race([
      win.webContents.executeJavaScript(js, true) as Promise<T>,
      sleep(timeoutMs).then(() => {
        throw new BridgeError(`claude.ai page did not respond to: ${js.slice(0, 60)}…`, 'timeout');
      }),
    ]);
  }

  private async inject(): Promise<void> {
    if (!this.pageScript) {
      this.pageScript = readFileSync(join(__dirname, 'page-bridge.js'), 'utf8');
    }
    const prelude =
      `window.__ATLAS_SELECTORS = ${JSON.stringify(SELECTORS)};\n` +
      `window.__ATLAS_LIMITS = ${JSON.stringify(LIMIT_PATTERNS)};\n`;
    await this.run(prelude + this.pageScript, 15_000);
  }

  private page<T>(expr: string, timeoutMs?: number): Promise<T> {
    return this.run<T>(`window.__atlasBridge.${expr}`, timeoutMs);
  }

  // ------------------------------------------------------------ conversation
  async startConversation(resumeUrl?: string): Promise<void> {
    const win = this.window();
    const target = resumeUrl && resumeUrl.startsWith('https://claude.ai/') ? resumeUrl : CLAUDE_NEW;
    try {
      await win.loadURL(target);
    } catch (err) {
      // ERR_ABORTED is routine when the SPA redirects during load
      if (!/ERR_ABORTED/.test(String(err))) throw new BridgeError(`Could not load claude.ai: ${err}`, 'network');
    }
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        await this.inject();
        const info = await this.page<PageInfo>('pageInfo()', 5_000);
        if (info.onLogin) throw new BridgeError('Not signed in to claude.ai — sign in again.', 'not_signed_in');
        if (info.hasEditor) return;
      } catch (e) {
        if (e instanceof BridgeError && e.kind === 'not_signed_in') throw e;
      }
      await sleep(400);
    }
    throw new BridgeError('claude.ai did not finish loading (composer not found).', 'dom');
  }

  // -------------------------------------------------------------------- send
  async send(msg: BridgeMessage, signal: AbortSignal): Promise<BridgeResult> {
    const abort = () => new BridgeError('Cancelled', 'aborted');
    if (signal.aborted) throw abort();
    await this.inject();

    const info = await this.page<PageInfo>('pageInfo()', 10_000);
    if (info.onLogin) throw new BridgeError('Not signed in to claude.ai — sign in again.', 'not_signed_in');

    const before = await this.page<number>('assistantCount()');
    if (msg.image) {
      const img = prepareImage(msg.image);
      const res = await this.page<{ attached: boolean; strategy: string | null }>(
        `attachImage(${JSON.stringify(img.buffer.toString('base64'))}, "image/jpeg", "screen.jpg")`,
        90_000,
      );
      if (!res.attached) {
        throw new BridgeError('Could not attach the screenshot to claude.ai (the page layout may have changed).', 'dom');
      }
      this.log(`screenshot attached via ${res.strategy} (${Math.round(img.buffer.length / 1024)} KB)`);
    }
    await this.page(`setText(${JSON.stringify(msg.text)})`, 30_000);

    this.completion = null;
    const sentAt = Date.now();
    await this.page('send()', 30_000);

    let lastText = '';
    let stableSince = Date.now();
    while (true) {
      if (signal.aborted) {
        await this.page('stop()', 5_000).catch(() => undefined);
        throw abort();
      }
      if (Date.now() - sentAt > RESPONSE_TIMEOUT_MS) {
        await this.page('stop()', 5_000).catch(() => undefined);
        throw new BridgeError('Timed out waiting for Claude to answer.', 'timeout');
      }

      const c = this.lastCompletion();
      if (c && c.status === 429) throw new BridgeError('Claude usage limit reached for your plan. Try again later.', 'rate_limit');
      if (c && (c.status === 401 || c.status === 403)) {
        throw new BridgeError(`claude.ai rejected the request (HTTP ${c.status}). Sign in again, or complete any Cloudflare check at claude.ai.`, 'not_signed_in');
      }

      const st = await this.page<PageState>('state()', 10_000);
      if (st.error?.kind === 'rate_limit') throw new BridgeError(`Claude: ${st.error.text}`, 'rate_limit');

      if (st.count > before) {
        if (st.text !== lastText) {
          lastText = st.text;
          stableSince = Date.now();
        }
        const quietFor = Date.now() - stableSince;
        const networkDone = (this.lastCompletion()?.at ?? 0) >= sentAt;
        if (!st.streaming && st.text.trim() && quietFor >= (networkDone ? 500 : 1800)) {
          return {
            text: st.text,
            codeBlocks: st.codeBlocks,
            conversationUrl: /\/chat\//.test(st.url) ? st.url : undefined,
          };
        }
      } else if (st.error?.kind === 'error' && Date.now() - sentAt > 8_000) {
        throw new BridgeError(`Claude reported an error: ${st.error.text}`, 'dom');
      }
      await sleep(350);
    }
  }

  // --------------------------------------------------------------- diagnosis
  async diagnose(): Promise<BridgeDiagnosis> {
    const notes: string[] = [];
    try {
      await this.startConversation();
    } catch (e) {
      return { ok: false, url: this.win?.webContents.getURL() ?? '', signedIn: !(e instanceof BridgeError && e.kind === 'not_signed_in'), checks: {}, notes: [String(e instanceof Error ? e.message : e)] };
    }
    const d = await this.page<{ info: PageInfo; counts: Record<string, number[]> }>('diagnose()', 10_000);
    const checks: Record<string, number | boolean> = {};
    for (const [name, hits] of Object.entries(d.counts)) {
      const best = hits.findIndex((n) => n > 0);
      checks[name] = best >= 0 ? hits[best] : 0;
      if (best < 0 && ['editor', 'sendButton'].includes(name)) notes.push(`No selector matched for "${name}" — update electron/bridge/selectors.ts`);
      if (best > 0) notes.push(`"${name}" only matched fallback selector #${best + 1}`);
    }
    const ok = d.info.hasEditor && !d.info.onLogin;
    return { ok, url: d.info.url, signedIn: !d.info.onLogin, checks, notes };
  }

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
