import { app, nativeTheme } from 'electron';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendInfo, BackendState, Settings } from '../shared/types';
import { AgentRunner } from './agent/runner';
import { AuthManager, PARTITION } from './auth';
import { BackendClient } from './backend/client';
import { type Sidecar, startSidecar } from './backend/sidecar';
import { CliBridge } from './bridge/cliBridge';
import type { ClaudeBridge } from './bridge/types';
import { WebBridge } from './bridge/webBridge';
import { registerIpc } from './ipc';
import { Store } from './store';
import { Windows } from './windows';

// ------------------------------------------------------------ process-level flags
// The Mini-HUD relies on X11 window types / always-on-top. On Wayland sessions, XWayland honours
// them where native Wayland windows would not.
if (process.env.DISPLAY && !process.env.ATLAS_NATIVE_WAYLAND) app.commandLine.appendSwitch('ozone-platform', 'x11');

/** AppImages cannot ship a SUID chrome-sandbox, so Chromium needs unprivileged user namespaces. Only
 *  disable the sandbox when the kernel/AppArmor does not provide them (e.g. Ubuntu 24.04 default). */
function userNamespacesBlocked(): boolean {
  const read = (p: string) => {
    try { return readFileSync(p, 'utf8').trim(); } catch { return ''; }
  };
  return (
    read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' ||
    read('/proc/sys/kernel/unprivileged_userns_clone') === '0' ||
    read('/proc/sys/user/max_user_namespaces') === '0'
  );
}
if (process.env.APPIMAGE && userNamespacesBlocked()) app.commandLine.appendSwitch('no-sandbox');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ------------------------------------------------------------------------- state
let store: Store;
let auth: AuthManager;
let windows: Windows;
let runner: AgentRunner;
let sidecar: Sidecar | null = null;
let client: BackendClient | null = null;
let backendState: BackendState = { status: 'starting' };
let bridge: ClaudeBridge | null = null;
let quitting = false;
let restarts = 0;
let logFile = '';

function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}`;
  if (!app.isPackaged) console.log(text);
  try {
    appendFileSync(logFile, text + '\n');
  } catch {
    /* logging must never crash the app */
  }
}

function setBackendState(next: BackendState): void {
  backendState = next;
  windows?.broadcast({ type: 'backend', state: next });
}

// ------------------------------------------------------------------------ bridge
function getBridge(): ClaudeBridge {
  const s = store.settings;
  if (bridge && bridge.kind === s.bridgeMode) return bridge;
  bridge?.dispose();
  bridge = s.bridgeMode === 'cli'
    ? new CliBridge(s.cliPath, app.getPath('userData'), log)
    : new WebBridge(PARTITION, auth.userAgent, log);
  return bridge;
}

// ----------------------------------------------------------------------- backend
function voiceConfig(v: Settings['voice']): Record<string, unknown> {
  return {
    input_device: v.inputDevice, output_device: v.outputDevice, whisper_model: v.whisperModel, language: v.language,
    tts_engine: v.ttsEngine, tts_voice: v.ttsVoice, wake_word: v.wakeWord, hands_free: v.handsFree,
  };
}

function applySettings(s: Settings): void {
  nativeTheme.themeSource = s.theme;
  if (windows.hud && !windows.hud.isDestroyed() && !windows.hud.isVisible()) windows.hud.destroy(); // pick up hudType
  if (bridge && bridge.kind !== s.bridgeMode) {
    bridge.dispose();
    bridge = null;
  }
  void client?.call('voice.configure', voiceConfig(s.voice)).catch((e) => log(`voice.configure failed: ${e}`));
  windows.broadcast({ type: 'settings', settings: s });
}

function routeBackendEvent(name: string, data: Record<string, unknown>): void {
  switch (name) {
    case 'kill.triggered':
      runner.onKillTriggered(String(data.source ?? 'unknown'));
      break;
    case 'kill.reset':
      windows.broadcast({ type: 'kill', active: false });
      break;
    case 'voice.level':
      windows.broadcast({ type: 'voice:level', level: Number(data.level) || 0, source: data.source === 'tts' ? 'tts' : 'mic' });
      break;
    case 'voice.state':
      windows.broadcast({ type: 'voice:state', state: data.state as never, mode: data.mode as string | undefined });
      break;
    case 'voice.error':
      windows.broadcast({ type: 'voice:error', message: String(data.message ?? 'Voice error') });
      break;
    case 'voice.status':
      windows.broadcast({ type: 'voice:status', message: String(data.message ?? '') });
      break;
    case 'voice.interrupt':
      runner.pause('you spoke');
      break;
    case 'voice.ignored':
      if (runner.getState().status === 'paused') runner.resume();
      break;
    case 'voice.transcript': {
      const text = String(data.text ?? '').trim();
      if (!text) break;
      if (runner.hasPendingConfirmation() && runner.handleVoiceAnswer(text)) break;
      if (runner.isRunning()) {
        runner.interject(text); // voice interruption: pause → new instruction replaces the plan
        break;
      }
      windows.broadcast({ type: 'voice:transcript', text, source: String(data.source ?? 'voice') });
      break;
    }
    default:
      break;
  }
}

async function startBackend(): Promise<void> {
  setBackendState({ status: 'starting' });
  try {
    sidecar = await startSidecar(log);
    const sc = sidecar;
    sc.child.once('exit', (code) => {
      if (quitting || sidecar !== sc) return;
      log(`backend exited unexpectedly (code ${code})`);
      client?.close();
      client = null;
      sidecar = null;
      setBackendState({ status: 'error', error: `The OS-automation backend stopped unexpectedly (code ${code}).` });
      if (restarts++ < 3) setTimeout(() => void startBackend(), 1500);
    });
    client = new BackendClient(`ws://127.0.0.1:${sc.port}/ws?token=${sc.token}`);
    await client.connect();
    client.on('event', (n: string, d: Record<string, unknown>) => routeBackendEvent(n, d));
    const info = await client.call<BackendInfo>('env.info', {}, 30_000);
    await client.call('voice.configure', voiceConfig(store.settings.voice)).catch((e) => log(`voice.configure: ${e}`));
    setBackendState({ status: 'ready', info });
    restarts = 0;
    log(`backend ready: ${info.session.kind} session, input=${info.input.driver}, atspi=${info.atspi.available}, hotkeys=${info.hotkeys.source}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`backend failed to start: ${message}`);
    setBackendState({ status: 'error', error: message });
  }
}

async function shutdownBackend(): Promise<void> {
  const sc = sidecar;
  sidecar = null;
  client?.close();
  client = null;
  await sc?.stop();
}

// ---------------------------------------------------------------------- lifecycle
app.on('second-instance', () => {
  const w = windows?.main;
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  logFile = join(userData, 'claude-os-agent.log');
  store = new Store(userData);
  nativeTheme.themeSource = store.settings.theme;
  auth = new AuthManager();
  windows = new Windows(() => store.settings, join(__dirname, 'preload.js'));

  runner = new AgentRunner({
    backend: () => client,
    backendInfo: () => backendState.info,
    getBridge,
    store,
    settings: () => store.settings,
    emit: (e) => windows.broadcast(e),
    enterHud: () => windows.enterHud(),
    exitHud: () => windows.exitHud(),
    hudMask: () => windows.hudMask(),
    setHudExpanded: (x) => windows.setHudExpanded(x),
    onAuthProblem: () => void auth.refresh(),
    log,
  });

  registerIpc({
    store, auth, windows, runner,
    backend: () => client,
    backendState: () => backendState,
    applySettings,
    diagnoseBridge: async () => {
      const b = getBridge();
      if (b instanceof WebBridge) return b.diagnose();
      return { ok: false, url: '', signedIn: true, checks: {}, notes: ['The diagnostic only applies to the claude.ai web bridge (current mode: CLI).'] };
    },
    logout: async () => {
      bridge?.dispose();
      bridge = null;
      await auth.logout();
    },
  });

  auth.on('state', (state) => {
    windows.broadcast({ type: 'auth', state });
    if (state.status === 'signed_in') windows.hideLogin(); // cookie captured → swap to the Agent UI
  });

  windows.createMain();
  void auth.refresh();
  void startBackend();
});

app.on('window-all-closed', () => {
  if (!windows.hud || windows.hud.isDestroyed() || !windows.hud.isVisible()) app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  store?.flush();
  bridge?.dispose();
  void runner?.stop('user');
  shutdownBackend().finally(() => app.exit(0));
});

// last-resort: never leave the Python sidecar orphaned
process.on('exit', () => sidecar?.child.kill('SIGKILL'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());
