import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError, type BridgeMessage, type BridgeResult, type ClaudeBridge } from './types';

/** Env vars that would make the CLI bill an API account instead of the Pro/Max subscription. */
const BILLING_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
];

export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of BILLING_ENV) delete out[k];
  return out;
}

/**
 * Fallback bridge: pipes prompts into the local `claude` CLI (`claude -p`), which must be
 * logged in with `claude login` using a Claude Pro/Max account (OAuth, no API key).
 * Screenshots are written to a private work dir and read by the CLI's Read tool; every other
 * tool is disallowed so the CLI can only look at the image and answer.
 */
export class CliBridge implements ClaudeBridge {
  readonly kind = 'cli' as const;
  private sessionId: string | undefined;
  private readonly workDir: string;

  constructor(private readonly cliPath: string, userDataDir: string, private readonly log: (m: string) => void = () => undefined) {
    this.workDir = join(userDataDir, 'cli-work');
    mkdirSync(this.workDir, { recursive: true });
  }

  async startConversation(): Promise<void> {
    this.sessionId = undefined;
    for (const f of readdirSync(this.workDir)) if (f.startsWith('screen-')) rmSync(join(this.workDir, f), { force: true });
  }

  send(msg: BridgeMessage, signal: AbortSignal): Promise<BridgeResult> {
    let prompt = msg.text;
    if (msg.image) {
      const name = `screen-${Date.now()}.jpg`;
      writeFileSync(join(this.workDir, name), msg.image);
      prompt += `\n\nThe current screenshot is the file ./${name} in your working directory. Read it with the Read tool first.`;
    }
    const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--max-turns', '5'];
    if (this.sessionId) args.push('--resume', this.sessionId);

    return new Promise<BridgeResult>((resolve, reject) => {
      if (signal.aborted) return reject(new BridgeError('Cancelled', 'aborted'));
      const child = spawn(this.cliPath, args, { cwd: this.workDir, env: subscriptionEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const onAbort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new BridgeError(missing ? `Claude CLI not found ("${this.cliPath}"). Install it and run \`claude login\` with your Pro account.` : String(err), 'cli'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return reject(new BridgeError('Cancelled', 'aborted'));
        try {
          const lines = stdout.trim().split('\n');
          const data = JSON.parse(lines[lines.length - 1] || '{}') as { result?: string; session_id?: string; is_error?: boolean };
          if (data.session_id) this.sessionId = data.session_id;
          if (data.is_error || (code !== 0 && !data.result)) throw new Error(data.result || stderr);
          const text = data.result ?? '';
          resolve({ text, codeBlocks: [] });
        } catch (e) {
          const detail = (stderr || stdout || String(e)).trim().slice(0, 400);
          const login = /log ?in|authenticat|credential/i.test(detail);
          reject(new BridgeError(login ? 'Claude CLI is not logged in — run `claude login` with your Pro account.' : `Claude CLI failed: ${detail}`, login ? 'not_signed_in' : 'cli'));
        }
      });
      child.stdin.end(prompt);
      this.log(`claude -p (${msg.image ? 'with screenshot' : 'text only'}${this.sessionId ? ', resumed' : ''})`);
    });
  }

  dispose(): void {
    /* nothing persistent */
  }
}
