import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel, InvokeMap, SendMap } from '../shared/ipc';
import type {
  AgentState, AudioDevices, AuthState, BackendState, BridgeDiagnosis, Settings,
} from '../shared/types';
import type { AgentRunner } from './agent/runner';
import type { AuthManager } from './auth';
import type { BackendClient } from './backend/client';
import type { Store } from './store';
import type { Windows } from './windows';

export interface IpcContext {
  store: Store;
  auth: AuthManager;
  windows: Windows;
  runner: AgentRunner;
  backend: () => BackendClient | null;
  backendState: () => BackendState;
  applySettings: (s: Settings) => void;
  diagnoseBridge: () => Promise<BridgeDiagnosis>;
  logout: () => Promise<void>;
}

const str = (v: unknown, max = 20_000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument');
  return v;
};

export function registerIpc(c: IpcContext): void {
  const trusted = (e: IpcMainInvokeEvent) =>
    e.sender === c.windows.main?.webContents || e.sender === c.windows.hud?.webContents;

  const handle = <C extends InvokeChannel>(
    channel: C,
    fn: (...args: InvokeMap[C]['args']) => InvokeMap[C]['result'] | Promise<InvokeMap[C]['result']>,
  ): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('Untrusted IPC sender');
      return fn(...(args as InvokeMap[C]['args']));
    });
  };
  const backendCall = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const b = c.backend();
    if (!b) return Promise.reject(new Error('Backend is not running'));
    return b.call<T>(method, params);
  };

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    wmType: process.env.XDG_SESSION_TYPE ?? 'unknown',
  }));
  handle('backend:state', () => c.backendState());

  handle('auth:state', (): AuthState => c.auth.state);
  handle('auth:beginLogin', () => c.windows.showLogin());
  handle('auth:cancelLogin', () => c.windows.hideLogin());
  handle('auth:logout', () => c.logout());
  handle('bridge:diagnose', () => c.diagnoseBridge());

  handle('settings:get', () => c.store.settings);
  handle('settings:set', (patch) => {
    const next = c.store.setSettings(patch);
    c.applySettings(next);
    return next;
  });

  handle('chat:list', () => c.store.listChats());
  handle('chat:get', (id) => c.store.getChat(str(id, 64)));
  handle('chat:create', () => {
    const chat = c.store.createChat();
    c.windows.broadcast({ type: 'chat:list', chats: c.store.listChats() });
    return chat;
  });
  handle('chat:delete', (id) => {
    c.store.deleteChat(str(id, 64));
    c.windows.broadcast({ type: 'chat:list', chats: c.store.listChats() });
  });

  handle('workflow:list', () => c.store.workflows());
  handle('workflow:save', (w) => c.store.saveWorkflow(str(w.name, 200), str(w.prompt)));
  handle('workflow:delete', (id) => c.store.deleteWorkflow(str(id, 64)));

  handle('agent:state', (): AgentState => c.runner.getState());
  handle('agent:start', (req) => {
    c.runner.start({
      chatId: str(req.chatId, 64),
      text: str(req.text),
      mode: req.mode === 'chat' ? 'chat' : 'agent',
      via: req.via === 'voice' ? 'voice' : 'text',
    });
  });
  handle('agent:stop', () => c.runner.stop('user'));
  handle('agent:takeover', () => c.runner.stop('user'));
  handle('agent:pause', () => c.runner.pause('manual'));
  handle('agent:resume', () => c.runner.resume());
  handle('agent:confirm', (r) => c.runner.confirm(str(r.id, 64), r.approved === true));

  handle('kill:trigger', async () => {
    await backendCall('kill.trigger', { source: 'ui' });
  });
  handle('kill:reset', async () => {
    await backendCall('kill.reset');
    c.windows.broadcast({ type: 'kill', active: false });
  });

  handle('voice:devices', () => backendCall<AudioDevices>('voice.devices'));
  handle('voice:ptt', async (down) => {
    await backendCall('voice.ptt', { down: down === true });
  });
  handle('voice:handsFree', async (on) => {
    const next = c.store.setSettings({ voice: { ...c.store.settings.voice, handsFree: on === true } });
    c.applySettings(next);
  });
  handle('voice:speak', async (text) => {
    await backendCall('voice.speak', { text: str(text, 4000) });
  });
  handle('voice:stopSpeaking', async () => {
    await backendCall('voice.stop_speaking');
  });

  ipcMain.on('auth:loginBounds', (e, rect: SendMap['auth:loginBounds'][0]) => {
    if (e.sender !== c.windows.main?.webContents) return;
    if (!rect) return c.windows.setLoginBounds(null);
    const ok = [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number' && Number.isFinite(n));
    if (ok && rect.width > 0 && rect.height > 0) c.windows.setLoginBounds(rect);
  });
}
