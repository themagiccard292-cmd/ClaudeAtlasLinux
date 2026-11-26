import { app, BrowserWindow, nativeTheme, screen, shell, WebContentsView } from 'electron';
import { join } from 'node:path';
import type { AtlasEvent } from '../shared/ipc';
import type { Settings } from '../shared/types';
import { PARTITION } from './auth';
import { CLAUDE_LOGIN } from './bridge/selectors';

const DEV_URL = 'http://localhost:5173/';
const HUD_W = 560;
const HUD_H = 72;
const HUD_H_CONFIRM = 300; // approval card (reason + command + buttons) stacked above the 72px pill
const HUD_MARGIN = 28;

export interface HudMask {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Windows {
  main: BrowserWindow | null = null;
  hud: BrowserWindow | null = null;
  private login: WebContentsView | null = null;
  private loginBounds: Electron.Rectangle | null = null;
  private hudExpanded = false;

  constructor(private readonly getSettings: () => Settings, private readonly preload: string) {}

  // --------------------------------------------------------------- renderer
  private load(win: BrowserWindow, hash?: string): void {
    if (process.env.ATLAS_DEV) void win.loadURL(DEV_URL + (hash ? `#${hash}` : ''));
    else void win.loadFile(join(app.getAppPath(), 'dist', 'index.html'), hash ? { hash } : undefined);
  }

  private secure(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      const own = url.startsWith(DEV_URL) || url.startsWith('file://');
      if (!own) e.preventDefault();
    });
  }

  broadcast(event: AtlasEvent): void {
    for (const win of [this.main, this.hud]) {
      if (win && !win.isDestroyed()) win.webContents.send('atlas:event', event);
    }
  }

  // ------------------------------------------------------------------- main
  createMain(): BrowserWindow {
    const dark = nativeTheme.shouldUseDarkColors;
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      title: 'Claude OS Agent',
      backgroundColor: dark ? '#262624' : '#F5F4EF',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    this.secure(win);
    // `ready-to-show` never fires on some GPU/driver setups, which left an invisible window that the
    // dock could not raise. Show on whichever comes first: ready-to-show, load finished, or 4 s.
    const reveal = () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    };
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
    setTimeout(reveal, 4000);
    win.on('closed', () => {
      this.main = null;
      this.hideLogin();
    });
    this.load(win);
    this.main = win;
    return win;
  }

  // -------------------------------------------------------------------- HUD
  /**
   * The Mini-HUD is a separate frameless, transparent, always-on-top window. `type` can only be set
   * at construction on Linux, hence a dedicated window instead of morphing the main one.
   * Returns the HUD rectangle as fractions of the primary display so the backend can paint it out of
   * screenshots (Claude must not see — or click — the agent's own STOP button).
   */
  enterHud(): HudMask | null {
    if (!this.hud || this.hud.isDestroyed()) {
      const hud = new BrowserWindow({
        width: HUD_W,
        height: HUD_H,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        type: this.getSettings().hudType, // 'dock' | 'toolbar' (X11 window types)
        webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      hud.setAlwaysOnTop(true, 'screen-saver');
      hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      hud.on('closed', () => {
        this.hud = null;
      });
      this.secure(hud);
      this.load(hud, '/hud');
      this.hud = hud;
    }
    this.hudExpanded = false;
    this.placeHud();
    this.hud.showInactive(); // never steal focus from the app the agent is driving
    this.main?.hide();
    this.broadcast({ type: 'hud', active: true });
    return this.hudMask();
  }

  exitHud(): void {
    if (this.hud && !this.hud.isDestroyed()) this.hud.hide();
    if (this.main && !this.main.isDestroyed()) {
      this.main.show();
      this.main.focus();
    }
    this.broadcast({ type: 'hud', active: false });
  }

  /** Grow the pill to show Approve / Deny buttons. */
  setHudExpanded(expanded: boolean): void {
    this.hudExpanded = expanded;
    this.placeHud();
  }

  private placeHud(): void {
    if (!this.hud || this.hud.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const h = this.hudExpanded ? HUD_H_CONFIRM : HUD_H;
    this.hud.setBounds({
      x: Math.round(area.x + (area.width - HUD_W) / 2),
      y: Math.round(area.y + area.height - HUD_H - HUD_MARGIN - (h - HUD_H)),
      width: HUD_W,
      height: h,
    });
  }

  hudMask(): HudMask | null {
    if (!this.hud || this.hud.isDestroyed() || !this.hud.isVisible()) return null;
    const display = screen.getPrimaryDisplay().bounds;
    const b = this.hud.getBounds();
    const pad = 8;
    const x = Math.max(0, b.x - pad - display.x);
    const y = Math.max(0, b.y - pad - display.y);
    return {
      x: x / display.width,
      y: y / display.height,
      w: Math.min(display.width - x, b.width + pad * 2) / display.width,
      h: Math.min(display.height - y, b.height + pad * 2) / display.height,
    };
  }

  // ------------------------------------------------------------------ login
  /** Embeds the official claude.ai/login page inside the main window (shared persistent partition). */
  showLogin(): void {
    if (this.login || !this.main) return;
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      // OAuth popups (Google / Apple / SSO) are allowed, but only https and only inside our partition
      if (!/^https:\/\//.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, parent: this.main ?? undefined, autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    });
    this.main.contentView.addChildView(view);
    view.setVisible(false);
    if (this.loginBounds) this.applyLoginBounds();
    void view.webContents.loadURL(CLAUDE_LOGIN);
    this.login = view;
  }

  setLoginBounds(rect: Electron.Rectangle | null): void {
    this.loginBounds = rect;
    this.applyLoginBounds();
  }

  private applyLoginBounds(): void {
    if (!this.login) return;
    if (!this.loginBounds) {
      this.login.setVisible(false);
      return;
    }
    const r = this.loginBounds;
    this.login.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    this.login.setVisible(true);
  }

  hideLogin(): void {
    const view = this.login;
    this.login = null;
    if (!view) return;
    try {
      this.main?.contentView.removeChildView(view);
    } catch {
      /* window already gone */
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
