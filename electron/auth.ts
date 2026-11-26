import { app, type Session, session } from 'electron';
import { EventEmitter } from 'node:events';
import type { AuthState } from '../shared/types';
import { CLAUDE_ORIGIN } from './bridge/selectors';
import { planFromOrgs } from './planDetect';

export const PARTITION = 'persist:claude-pro';
const COOKIE_NAME = 'sessionKey';

/** A plain Chrome UA: Google/Cloudflare reject UAs that announce "Electron". */
export function browserUserAgent(raw: string): string {
  const appToken = app.getName().replace(/\s+/g, '');
  return raw
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${appToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`, 'i'), '')
    .replace(/\sclaude-os-agent\/\S+/i, '');
}

/**
 * Owns the persistent `persist:claude-pro` session. The user signs in once through the official
 * claude.ai/login page; we only ever look at the `sessionKey` cookie's *presence* and ask
 * claude.ai which plan the account has. The cookie value itself is never read or stored by us —
 * it stays inside Chromium's cookie jar.
 */
export class AuthManager extends EventEmitter {
  readonly ses: Session;
  readonly userAgent: string;
  state: AuthState = { status: 'checking' };
  private debounce: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.ses = session.fromPartition(PARTITION);
    this.userAgent = browserUserAgent(this.ses.getUserAgent());
    this.ses.setUserAgent(this.userAgent);
    this.ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    this.ses.cookies.on('changed', (_e, cookie) => {
      if (cookie.name === COOKIE_NAME && (cookie.domain ?? '').includes('claude.ai')) this.scheduleRefresh();
    });
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 600);
  }

  private set(state: AuthState): AuthState {
    const changed = JSON.stringify(state) !== JSON.stringify(this.state);
    this.state = state;
    if (changed) this.emit('state', state);
    return state;
  }

  private async hasSessionCookie(): Promise<boolean> {
    const cookies = await this.ses.cookies.get({ url: CLAUDE_ORIGIN, name: COOKIE_NAME });
    return cookies.length > 0;
  }

  private async getJson(path: string): Promise<{ status: number; json?: unknown }> {
    try {
      const res = await this.ses.fetch(`${CLAUDE_ORIGIN}${path}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return { status: res.status };
      return { status: res.status, json: await res.json() };
    } catch {
      return { status: 0 };
    }
  }

  async refresh(): Promise<AuthState> {
    if (!(await this.hasSessionCookie())) return this.set({ status: 'signed_out' });

    const orgs = await this.getJson('/api/organizations');
    if (orgs.status === 401) {
      return this.set({ status: 'signed_out', error: 'Your claude.ai session expired. Please sign in again.' });
    }
    if (orgs.status !== 200) {
      // Cookie exists but claude.ai could not be queried (offline / Cloudflare). Trust the cookie.
      return this.set({ status: 'signed_in', plan: 'unknown', unverified: true });
    }
    const { plan, orgName } = planFromOrgs(orgs.json);
    const account = await this.getJson('/api/account');
    const email = (account.json as { email_address?: string } | undefined)?.email_address;
    return this.set({ status: 'signed_in', plan, orgName, email });
  }

  async logout(): Promise<void> {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    this.set({ status: 'signed_out' });
  }
}
