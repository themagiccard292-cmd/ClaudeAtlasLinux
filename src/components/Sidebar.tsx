import { useEffect, useState } from 'react';
import type { AudioDevices } from '../../shared/types';
import { atlas } from '../lib/atlas';
import { PLAN_LABEL, relativeTime } from '../lib/format';
import { useLevel, useUi } from '../store';
import { AudioVisualizer } from './AudioVisualizer';
import { IconBookmark, IconMic, IconPlay, IconPlus, IconSettings, IconTrash, SparkMark } from './Icons';

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="px-2">
      <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wider text-muted">
        {title}{action}
      </div>
      {children}
    </section>
  );
}

function AccountBadge() {
  const auth = useUi((s) => s.auth);
  const bridgeMode = useUi((s) => s.settings.bridgeMode);
  const plan = auth.plan ?? 'unknown';
  const isPro = plan === 'pro' || plan === 'max';
  if (bridgeMode === 'cli') {
    return <div className="flex items-center gap-2 text-sm"><span className="h-2 w-2 rounded-full bg-ok" />Claude CLI<span className="ml-auto rounded-full bg-line/70 px-2 py-0.5 text-[11px] text-muted">OAuth</span></div>;
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 rounded-full ${auth.status === 'signed_in' ? 'bg-ok' : 'bg-warn'}`} />
      <span className="min-w-0 flex-1 truncate" title={auth.email}>{auth.email ?? (auth.status === 'signed_in' ? 'Signed in' : 'Signed out')}</span>
      {auth.status === 'signed_in' && (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isPro ? 'bg-accent/15 text-accent' : 'bg-line/70 text-muted'}`}
          title={auth.unverified ? 'Plan could not be verified' : auth.orgName}>
          Claude {PLAN_LABEL[plan]}
        </span>
      )}
    </div>
  );
}

function VoiceQuick() {
  const { settings, patchSettings, voice } = useUi();
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const level = useLevel((s) => s.level);
  const backendReady = useUi((s) => s.backend.status === 'ready');

  useEffect(() => {
    if (!backendReady) return;
    void atlas().invoke('voice:devices').then(setDevices).catch(() => setDevices(null));
  }, [backendReady]);

  const v = settings.voice;
  const setVoice = (p: Partial<typeof v>) => void patchSettings({ voice: { ...v, ...p } });
  const listening = voice.state === 'listening' || voice.state === 'hearing';

  return (
    <div className="space-y-2 rounded-xl border border-line bg-raised/50 p-2.5">
      <div className="flex items-center gap-2 text-xs text-muted">
        <IconMic size={14} /> Voice & audio
        <AudioVisualizer width={64} height={16} bars={12} active={listening || voice.state === 'speaking'} className="ml-auto text-accent" />
        <span className="sr-only">level {Math.round(level * 100)}</span>
      </div>
      <label className="block text-xs text-muted">
        Microphone
        <select value={v.inputDevice ?? ''} onChange={(e) => setVoice({ inputDevice: e.target.value === '' ? null : Number(e.target.value) })}
          className="mt-0.5 w-full truncate rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink">
          <option value="">System default</option>
          {devices?.input.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}
        </select>
      </label>
      {devices?.error && <p className="text-[11px] text-warn">{devices.error}</p>}
      <label className="flex cursor-pointer items-center justify-between text-xs">
        <span>Hands-free listening<span className="block text-[11px] text-muted">Say “{v.wakeWord || 'hey claude'}…”</span></span>
        <input type="checkbox" checked={v.handsFree} onChange={(e) => setVoice({ handsFree: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
      </label>
      <label className="flex cursor-pointer items-center justify-between text-xs">
        Speak replies aloud
        <input type="checkbox" checked={v.speakReplies} onChange={(e) => setVoice({ speakReplies: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
      </label>
    </div>
  );
}

export function Sidebar() {
  const { chats, activeId, workflows, selectChat, newChat, deleteChat, set, chat, mode } = useUi();
  const running = useUi((s) => s.agent.status !== 'idle');

  const saveWorkflow = async () => {
    const firstUser = chat?.messages.find((m) => m.role === 'user');
    if (!firstUser) return useUi.getState().toast('info', 'Send a task first, then save it as a workflow.');
    const name = window.prompt('Name this workflow', chat?.title ?? '');
    if (!name) return;
    set({ workflows: await atlas().invoke('workflow:save', { name, prompt: firstUser.content }) });
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col gap-4 border-r border-line bg-surface py-3" aria-label="Sidebar">
      <div className="flex items-center gap-2 px-4">
        <SparkMark size={20} className="text-accent" />
        <span className="font-serif text-lg font-medium tracking-tight">Claude OS Agent</span>
      </div>
      <div className="px-3">
        <button onClick={() => void newChat()}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm font-medium shadow-soft transition hover:border-accent/50">
          <IconPlus size={16} className="text-accent" /> New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <Section title="Chats">
          {chats.length === 0 && <p className="px-2 py-1 text-sm text-muted">No chats yet</p>}
          <ul>
            {chats.map((c) => (
              <li key={c.id} className="group relative">
                <button onClick={() => void selectChat(c.id)}
                  className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition ${c.id === activeId ? 'bg-line/60' : 'hover:bg-line/35'}`}>
                  <span className="truncate pr-6 text-sm">{c.title}</span>
                  <span className="text-[11px] text-muted">{relativeTime(c.updatedAt)}</span>
                </button>
                <button onClick={() => void deleteChat(c.id)} aria-label={`Delete ${c.title}`}
                  className="absolute right-1.5 top-2 hidden rounded p-1 text-muted hover:bg-line hover:text-danger group-hover:block">
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Saved workflows" action={
          <button onClick={() => void saveWorkflow()} title="Save the current task as a workflow" className="rounded p-0.5 normal-case hover:bg-line hover:text-ink">
            <IconBookmark size={14} />
          </button>}>
          {workflows.length === 0 && <p className="px-2 py-1 text-sm text-muted">Save a task to re-run it with one click.</p>}
          <ul>
            {workflows.map((w) => (
              <li key={w.id} className="group flex items-center rounded-lg hover:bg-line/35">
                <button disabled={running} onClick={() => void useUi.getState().send(w.prompt)} title={w.prompt}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm disabled:opacity-50">
                  <IconPlay size={12} className="shrink-0 text-accent" /><span className="truncate">{w.name}</span>
                </button>
                <button onClick={async () => set({ workflows: await atlas().invoke('workflow:delete', w.id) })} aria-label={`Delete ${w.name}`}
                  className="mr-1.5 hidden rounded p-1 text-muted hover:text-danger group-hover:block"><IconTrash size={13} /></button>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="space-y-2.5 px-3">
        <VoiceQuick />
        <div className="rounded-xl border border-line bg-raised/50 p-2.5"><AccountBadge /></div>
        <button onClick={() => set({ settingsOpen: true })}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted transition hover:bg-line/40 hover:text-ink">
          <IconSettings size={16} /> Settings
          <span className="ml-auto text-[11px] capitalize">{mode} mode</span>
        </button>
      </div>
    </aside>
  );
}
