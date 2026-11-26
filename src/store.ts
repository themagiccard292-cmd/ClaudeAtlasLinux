import { create } from 'zustand';
import type { AtlasEvent } from '../shared/ipc';
import {
  type AgentState, type AppInfo, type SandboxState, type AuthState, type BackendState, type Chat, type ChatSummary, type ConfirmRequest,
  DEFAULT_SETTINGS, type Settings, type VoiceUiState, type Workflow,
} from '../shared/types';
import { atlas, isHudRoute } from './lib/atlas';
import { liveBus } from './lib/liveBus';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface UiState {
  loaded: boolean;
  appInfo?: AppInfo;
  auth: AuthState;
  backend: BackendState;
  settings: Settings;
  chats: ChatSummary[];
  activeId?: string;
  chat?: Chat;
  workflows: Workflow[];
  agent: AgentState;
  confirm: ConfirmRequest | null;
  voice: { state: VoiceUiState; status?: string };
  kill: { active: boolean; source?: string };
  hud: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  mode: 'agent' | 'chat';
  toasts: Toast[];
  loginRequested: boolean;
  liveOpen: boolean;
  sandbox: SandboxState | null;

  init(): Promise<void>;
  handleEvent(e: AtlasEvent): void;
  selectChat(id: string): Promise<void>;
  newChat(): Promise<void>;
  deleteChat(id: string): Promise<void>;
  send(text: string, via?: 'text' | 'voice'): Promise<void>;
  patchSettings(p: Partial<Settings>): Promise<void>;
  toast(level: Toast['level'], message: string): void;
  dismissToast(id: number): void;
  set(p: Partial<UiState>): void;
}

let toastId = 1;

export const useUi = create<UiState>((set, get) => ({
  loaded: false,
  auth: { status: 'checking' },
  backend: { status: 'starting' },
  settings: DEFAULT_SETTINGS,
  chats: [],
  workflows: [],
  agent: { status: 'idle', step: 0, maxSteps: 0 },
  confirm: null,
  voice: { state: 'idle' },
  kill: { active: false },
  hud: false,
  sidebarOpen: true,
  settingsOpen: false,
  mode: 'agent',
  toasts: [],
  loginRequested: false,
  liveOpen: false,
  sandbox: null,

  set: (p) => set(p),

  async init() {
    const a = atlas();
    a.onEvent((e) => get().handleEvent(e));
    const [appInfo, auth, backend, settings, agent] = await Promise.all([
      a.invoke('app:info'), a.invoke('auth:state'), a.invoke('backend:state'), a.invoke('settings:get'), a.invoke('agent:state'),
    ]);
    set({ appInfo, auth, backend, settings, agent, loaded: true, liveOpen: agent.status !== 'idle' && settings.desktopMode === 'sandbox' });
    if (isHudRoute()) return; // the HUD only needs live state
    const [chats, workflows] = await Promise.all([a.invoke('chat:list'), a.invoke('workflow:list')]);
    const sandbox = await a.invoke('sandbox:state').catch(() => null);
    set({ chats, workflows, sandbox });
    if (chats.length) await get().selectChat(chats[0].id);
  },

  handleEvent(e) {
    switch (e.type) {
      case 'backend': set({ backend: e.state }); break;
      case 'auth': set({ auth: e.state, loginRequested: e.state.status === 'signed_in' ? false : get().loginRequested }); break;
      case 'agent': {
        const wasIdle = get().agent.status === 'idle';
        // opening the live view automatically when a sandbox task starts is the whole point
        set({ agent: e.state, liveOpen: wasIdle && e.state.status !== 'idle' && get().settings.desktopMode === 'sandbox' ? true : get().liveOpen });
        break;
      }
      case 'live:frame': liveBus.emitFrame(e); break;
      case 'live:fx': liveBus.emitFx(e); break;
      case 'sandbox': set({ sandbox: e.state }); break;
      case 'chat:list': set({ chats: e.chats }); break;
      case 'chat:title': set({ chats: get().chats.map((c) => (c.id === e.chatId ? { ...c, title: e.title } : c)) }); break;
      case 'chat:message': {
        const chat = get().chat;
        if (!chat || chat.id !== e.chatId) break;
        const i = chat.messages.findIndex((m) => m.id === e.message.id);
        const messages = i >= 0 ? chat.messages.map((m, j) => (j === i ? e.message : m)) : [...chat.messages, e.message];
        set({ chat: { ...chat, messages } });
        break;
      }
      case 'confirm': set({ confirm: e.request }); break;
      case 'voice:level': useLevel.setState({ level: e.level, source: e.source }); break;
      case 'voice:state': set({ voice: { ...get().voice, state: e.state } }); break;
      case 'voice:status': set({ voice: { ...get().voice, status: e.message || undefined } }); break;
      case 'voice:error': get().toast('error', e.message); break;
      case 'voice:transcript':
        if (!isHudRoute()) void get().send(e.text, 'voice');
        break;
      case 'kill': set({ kill: { active: e.active, source: e.source } }); break;
      case 'hud': set({ hud: e.active }); break;
      case 'settings': set({ settings: e.settings }); break;
      case 'toast': get().toast(e.level, e.message); break;
    }
  },

  async selectChat(id) {
    const chat = await atlas().invoke('chat:get', id);
    if (chat) set({ activeId: id, chat });
  },

  async newChat() {
    const chat = await atlas().invoke('chat:create');
    set({ activeId: chat.id, chat });
  },

  async deleteChat(id) {
    await atlas().invoke('chat:delete', id);
    if (get().activeId === id) {
      const next = get().chats.find((c) => c.id !== id);
      if (next) await get().selectChat(next.id);
      else set({ activeId: undefined, chat: undefined });
    }
  },

  async send(text, via = 'text') {
    if (!text.trim()) return;
    let id = get().activeId;
    if (!id) {
      await get().newChat();
      id = get().activeId;
    }
    if (!id) return;
    try {
      await atlas().invoke('agent:start', { chatId: id, text, mode: get().mode, via });
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err));
    }
  },

  async patchSettings(p) {
    const settings = await atlas().invoke('settings:set', p);
    set({ settings });
  },

  toast(level, message) {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, level, message }] });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 9000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Mic/TTS level lives in its own store so 20 Hz updates never re-render the chat tree. */
export const useLevel = create<{ level: number; source: 'mic' | 'tts' }>(() => ({ level: 0, source: 'mic' }));
