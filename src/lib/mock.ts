// Browser-only stand-in for the Electron preload API, so the UI can be developed / screenshotted
// without Electron (`vite` then open /?mock=1&view=chat&theme=dark). Never used inside the app.
import type { AtlasApi, AtlasEvent } from '../../shared/ipc';
import { type Chat, DEFAULT_SETTINGS, type Settings } from '../../shared/types';

function fakeDesktop(): string {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 640, 360);
  bg.addColorStop(0, '#3b4a63');
  bg.addColorStop(1, '#1f2733');
  g.fillStyle = bg;
  g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#f4f2ec';
  g.fillRect(70, 50, 420, 250);
  g.fillStyle = '#d9d6cc';
  g.fillRect(70, 50, 420, 26);
  g.fillStyle = '#c96442';
  g.fillRect(84, 104, 120, 28);
  g.fillStyle = '#8a877e';
  for (let i = 0; i < 6; i++) g.fillRect(84, 150 + i * 20, 300 - (i % 3) * 50, 8);
  g.fillStyle = '#161b22';
  g.fillRect(0, 336, 640, 24);
  return c.toDataURL('image/jpeg', 0.7);
}

function seedChat(): Chat {
  const now = Date.now();
  const shot = fakeDesktop();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Open the downloads folder and sort it',
    createdAt: now - 600_000,
    updatedAt: now - 30_000,
    messages: [
      { id: 'm1', role: 'user', kind: 'text', content: 'Open my Downloads folder, list the 5 largest files, and tell me what they are.', createdAt: now - 590_000, via: 'voice' },
      {
        id: 'm2', role: 'assistant', kind: 'step', content: 'Opening a terminal to inspect Downloads.', createdAt: now - 580_000,
        step: {
          step: 1, thought: 'The fastest way to find the largest files is a shell one-liner, so I will use bash instead of clicking through the file manager.',
          screenshot: shot, shotWidth: 640, shotHeight: 360, changed: null,
          actions: [{
            id: 'a1', status: 'ok', action: { action: 'bash', command: 'ls -lS ~/Downloads | head -6' }, durationMs: 41,
            output: { exit_code: 0, stdout: 'total 4.2G\n-rw-r--r-- 1 me me 1.9G ubuntu-24.04.iso\n-rw-r--r-- 1 me me 812M backup-2025.tar.zst\n-rw-r--r-- 1 me me 344M talk.mp4\n', stderr: '' },
          }],
        },
      },
      {
        id: 'm3', role: 'assistant', kind: 'step', content: 'Opening the file manager to double-check.', createdAt: now - 560_000,
        step: {
          step: 2, thought: 'Let me confirm visually in the file manager, then I can answer.', screenshot: shot, shotWidth: 640, shotHeight: 360, changed: true,
          actions: [
            { id: 'a2', status: 'ok', action: { action: 'click', x: 148, y: 118, target: 'Files launcher' }, screen: { x: 296, y: 236 }, durationMs: 180 },
            { id: 'a3', status: 'ok', action: { action: 'hotkey', keys: ['ctrl', 'l'] }, durationMs: 60 },
            { id: 'a4', status: 'ok', action: { action: 'type', text: '~/Downloads' }, durationMs: 90 },
          ],
        },
      },
      {
        id: 'm4', role: 'assistant', kind: 'step', content: '', createdAt: now - 540_000,
        step: {
          step: 3, thought: 'I will remove the oldest ISO to free space — that deletes data, so this needs approval.', screenshot: shot, shotWidth: 640, shotHeight: 360, changed: true,
          actions: [{
            id: 'a5', status: 'awaiting_approval', action: { action: 'bash', command: 'rm ~/Downloads/ubuntu-24.04.iso' },
            risk: { reason: 'Deletes files or directories', category: 'destructive' },
          }],
        },
      },
      { id: 'm5', role: 'assistant', kind: 'text', content: 'The five largest files in **Downloads** are:\n\n1. `ubuntu-24.04.iso` — 1.9 GB\n2. `backup-2025.tar.zst` — 812 MB\n3. `talk.mp4` — 344 MB\n\n```bash\nls -lS ~/Downloads | head -6\n```\n\nWant me to archive the ISO?', createdAt: now - 30_000 },
    ],
  };
}

export function installMock(): void {
  const q = new URLSearchParams(window.location.search);
  const view = q.get('view') ?? 'chat';
  if (q.get('theme') === 'dark') document.documentElement.classList.add('dark');
  let settings: Settings = { ...DEFAULT_SETTINGS };
  const listeners = new Set<(e: AtlasEvent) => void>();
  const emit = (e: AtlasEvent) => listeners.forEach((l) => l(e));
  const chat = seedChat();
  const signedIn = view !== 'login';

  const api: AtlasApi = {
    async invoke(channel: string, ...args: unknown[]) {
      switch (channel) {
        case 'app:info': return { version: '0.1.0', platform: 'linux', packaged: false, userData: '/tmp/mock', wmType: 'x11' };
        case 'backend:state': return { status: 'ready', info: { version: '0.1.0', frozen: false, session: { kind: 'x11', desktop: 'GNOME', xwayland: false, detected_from: 'XDG_SESSION_TYPE', tools: { xdotool: true } }, input: { driver: 'xdotool', error: null }, atspi: { available: true }, hotkeys: { source: 'pynput', error: null, warning: null, kill_combo: 'Esc Esc', ptt_combo: 'alt+space' }, voice: {}, kill: { active: false, source: null }, primary_monitor: null } };
        case 'auth:state': return signedIn ? { status: 'signed_in', plan: 'pro', email: 'you@example.com' } : { status: 'signed_out' };
        case 'settings:get': return settings;
        case 'settings:set': settings = { ...settings, ...(args[0] as Partial<Settings>) }; return settings;
        case 'chat:list': return [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length }, { id: 'x2', title: 'Summarise unread email', updatedAt: Date.now() - 86_400_000, messageCount: 4 }, { id: 'x3', title: 'Install ripgrep and run it', updatedAt: Date.now() - 3 * 86_400_000, messageCount: 7 }];
        case 'chat:get': return chat;
        case 'chat:create': return { ...chat, id: '22222222-2222-4222-8222-222222222222', title: 'New chat', messages: [] };
        case 'workflow:list': return [{ id: 'w1', name: 'Morning briefing', prompt: 'Open my calendar and summarise today', createdAt: 1 }, { id: 'w2', name: 'Clean Downloads', prompt: 'Sort ~/Downloads by type', createdAt: 2 }];
        case 'agent:state': return view === 'running' || view === 'hud' || view === 'confirm' ? { status: view === 'confirm' ? 'waiting_confirmation' : 'running', chatId: chat.id, step: 3, maxSteps: 40, label: 'Clicking: Files launcher' } : { status: 'idle', step: 0, maxSteps: 40 };
        case 'voice:devices': return { input: [{ index: 0, name: 'Built-in Microphone', hostapi: 'ALSA', sample_rate: 48000 }, { index: 3, name: 'USB Headset', hostapi: 'ALSA', sample_rate: 48000 }], output: [{ index: 1, name: 'Built-in Speakers', hostapi: 'ALSA', sample_rate: 48000 }], default_input: 0, default_output: 1 };
        case 'bridge:diagnose': return { ok: true, url: 'https://claude.ai/new', signedIn: true, checks: { editor: 1, sendButton: 1 }, notes: [] };
        default: return undefined;
      }
    },
    send() { /* no-op */ },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as AtlasApi;

  window.atlas = api;
  if (view === 'confirm') {
    setTimeout(() => emit({ type: 'confirm', request: { id: 'c1', chatId: chat.id, reason: 'Deletes files or directories', category: 'destructive', action: { action: 'bash', command: 'rm ~/Downloads/ubuntu-24.04.iso' } } }), 300);
  }
  if (view === 'hud' || view === 'running' || view === 'confirm') {
    let t = 0;
    setInterval(() => emit({ type: 'voice:level', level: 0.25 + 0.55 * Math.abs(Math.sin(t += 0.45)), source: 'mic' }), 50);
    setTimeout(() => emit({ type: 'voice:state', state: 'listening' }), 100);
  }
  if (view === 'kill') setTimeout(() => emit({ type: 'kill', active: true, source: 'esc-esc' }), 200);
}
