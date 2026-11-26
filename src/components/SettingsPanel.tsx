import { type ReactNode, useEffect, useState } from 'react';
import type { AudioDevices, BridgeDiagnosis } from '../../shared/types';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { IconX } from './Icons';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0"><div className="text-sm">{label}</div>{hint && <div className="text-xs text-muted">{hint}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const input = 'rounded-md border border-line bg-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/60';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1 font-serif text-base font-medium">{title}</h3>
      <div className="divide-y divide-line rounded-xl border border-line bg-raised/50 px-4">{children}</div>
    </section>
  );
}

export function SettingsPanel() {
  const { settings, patchSettings, set, backend, auth, kill, update } = useUi();
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [diag, setDiag] = useState<BridgeDiagnosis | 'running' | null>(null);
  const v = settings.voice;
  const setVoice = (p: Partial<typeof v>) => void patchSettings({ voice: { ...v, ...p } });
  const info = backend.info;

  useEffect(() => {
    if (backend.status === 'ready') void atlas().invoke('voice:devices').then(setDevices).catch(() => undefined);
  }, [backend.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set({ settingsOpen: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  const runDiag = async () => {
    setDiag('running');
    try { setDiag(await atlas().invoke('bridge:diagnose')); } catch (e) { setDiag({ ok: false, url: '', signedIn: false, checks: {}, notes: [String(e)] }); }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && set({ settingsOpen: false })}>
      <div role="dialog" aria-label="Settings" className="h-full w-full max-w-xl animate-fade-in overflow-y-auto border-l border-line bg-bg p-6 shadow-soft">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-serif text-2xl font-medium">Settings</h2>
          <button onClick={() => set({ settingsOpen: false })} aria-label="Close settings" className="rounded-lg p-1.5 text-muted hover:bg-line/60 hover:text-ink"><IconX size={18} /></button>
        </div>

        <Card title="Appearance">
          <Row label="Theme">
            <select value={settings.theme} onChange={(e) => void patchSettings({ theme: e.target.value as typeof settings.theme })} className={input}>
              <option value="system">Match system</option><option value="light">Light (alabaster)</option><option value="dark">Dark (charcoal)</option>
            </select>
          </Row>
        </Card>

        <Card title="Claude connection">
          <Row label="How to reach Claude" hint="Both use your Pro subscription — never an API key.">
            <select value={settings.bridgeMode} onChange={(e) => void patchSettings({ bridgeMode: e.target.value as 'web' | 'cli' })} className={input}>
              <option value="web">claude.ai web session</option><option value="cli">Local claude CLI</option>
            </select>
          </Row>
          {settings.bridgeMode === 'cli' && (
            <Row label="CLI path" hint="Log in once with `claude login` (Pro/Max).">
              <input defaultValue={settings.cliPath} onBlur={(e) => void patchSettings({ cliPath: e.target.value || 'claude' })} className={`${input} w-44 font-mono`} />
            </Row>
          )}
          <Row label="Account" hint={auth.email ?? undefined}>
            <div className="flex gap-2">
              <button onClick={() => void runDiag()} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-line/50">Test bridge</button>
              {settings.bridgeMode === 'web' && <button onClick={() => void atlas().invoke('auth:logout')} className="rounded-md border border-line px-3 py-1.5 text-sm text-danger hover:bg-danger/10">Sign out</button>}
            </div>
          </Row>
          {diag && (
            <div className="py-3 text-sm">
              {diag === 'running' ? <span className="text-muted">Opening claude.ai in the background…</span> : (
                <>
                  <p className={diag.ok ? 'text-ok' : 'text-danger'}>{diag.ok ? '✓ Composer and send button found' : '✗ The bridge cannot drive claude.ai right now'}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">{Object.entries(diag.checks).map(([k, n]) => `${k}:${n}`).join('  ')}</p>
                  {diag.notes.map((n) => <p key={n} className="mt-1 text-xs text-warn">{n}</p>)}
                </>
              )}
            </div>
          )}
        </Card>

        <Card title="Agent">
          <Row label="Where Claude works" hint="Sandbox = a private virtual desktop you watch live. My desktop = your real screen.">
            <select value={settings.desktopMode} onChange={(e) => void patchSettings({ desktopMode: e.target.value as 'sandbox' | 'real' })} className={input}>
              <option value="sandbox">Sandbox desktop (live view)</option><option value="real">My desktop</option>
            </select>
          </Row>
          <Row label="Sandbox screen size" hint="Applies the next time the sandbox starts.">
            <select value={`${settings.sandboxWidth}x${settings.sandboxHeight}`} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); void patchSettings({ sandboxWidth: w, sandboxHeight: h }); }} className={input}>
              <option value="1280x720">1280 × 720</option><option value="1600x900">1600 × 900</option><option value="1920x1080">1920 × 1080</option>
            </select>
          </Row>
          <Row label="Max steps per task"><input type="number" min={1} max={200} value={settings.maxSteps} onChange={(e) => void patchSettings({ maxSteps: Math.max(1, Math.min(200, Number(e.target.value) || 40)) })} className={`${input} w-20`} /></Row>
          <Row label="Delay between actions" hint="Milliseconds"><input type="number" min={0} max={5000} step={100} value={settings.stepDelayMs} onChange={(e) => void patchSettings({ stepDelayMs: Math.max(0, Number(e.target.value) || 0) })} className={`${input} w-24`} /></Row>
          <Row label="Mini-HUD window type" hint="Try “toolbar” if your window manager hides the pill.">
            <select value={settings.hudType} onChange={(e) => void patchSettings({ hudType: e.target.value as 'dock' | 'toolbar' })} className={input}><option value="dock">dock</option><option value="toolbar">toolbar</option></select>
          </Row>
        </Card>

        <Card title="Voice (100% keyless)">
          <Row label="Microphone">
            <select value={v.inputDevice ?? ''} onChange={(e) => setVoice({ inputDevice: e.target.value === '' ? null : Number(e.target.value) })} className={`${input} max-w-[15rem]`}>
              <option value="">System default</option>{devices?.input.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}
            </select>
          </Row>
          <Row label="Speaker">
            <select value={v.outputDevice ?? ''} onChange={(e) => setVoice({ outputDevice: e.target.value === '' ? null : Number(e.target.value) })} className={`${input} max-w-[15rem]`}>
              <option value="">System default</option>{devices?.output.map((d) => <option key={d.index} value={d.index}>{d.name}</option>)}
            </select>
          </Row>
          <Row label="Speech recognition model" hint="Local faster-whisper; downloaded on first use.">
            <select value={v.whisperModel} onChange={(e) => setVoice({ whisperModel: e.target.value })} className={input}>
              {['tiny.en', 'base.en', 'small.en', 'tiny', 'base', 'small'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </Row>
          <Row label="Text-to-speech engine" hint="edge needs internet; piper/espeak are offline.">
            <select value={v.ttsEngine} onChange={(e) => setVoice({ ttsEngine: e.target.value as typeof v.ttsEngine })} className={input}>
              <option value="edge">edge-tts</option><option value="piper">piper</option><option value="espeak">espeak-ng</option><option value="off">off</option>
            </select>
          </Row>
          <Row label="Voice"><input defaultValue={v.ttsVoice} onBlur={(e) => setVoice({ ttsVoice: e.target.value })} className={`${input} w-48 font-mono text-xs`} /></Row>
          <Row label="Wake phrase" hint="Used in hands-free mode."><input defaultValue={v.wakeWord} onBlur={(e) => setVoice({ wakeWord: e.target.value })} className={`${input} w-40`} /></Row>
          <Row label="Speak replies aloud"><input type="checkbox" checked={v.speakReplies} onChange={(e) => setVoice({ speakReplies: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" /></Row>
          <Row label="Hands-free listening"><input type="checkbox" checked={v.handsFree} onChange={(e) => setVoice({ handsFree: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" /></Row>
        </Card>

        <Card title="Updates">
          <Row label="Version" hint={update?.status === 'disabled' ? update.reason : undefined}>
            <span className="font-mono text-sm">{update?.currentVersion ?? '—'}</span>
          </Row>
          <Row label="Status" hint={update?.method === 'deb' ? 'Installing a .deb update asks for your password.' : update?.method === 'appimage' ? 'The AppImage replaces itself.' : undefined}>
            <div className="flex items-center gap-3 text-sm">
              <span className={update?.status === 'error' ? 'text-danger' : update?.status === 'downloaded' || update?.status === 'available' ? 'text-accent' : 'text-muted'}>
                {{ disabled: 'Off', idle: 'Not checked yet', checking: 'Checking…', none: 'Up to date', available: `Version ${update?.version} available`, downloading: `Downloading ${update?.progress ?? 0}%`, downloaded: `Version ${update?.version} ready`, error: update?.error ?? 'Error' }[update?.status ?? 'idle']}
              </span>
              <button disabled={!update || update.status === 'disabled' || update.status === 'checking' || update.status === 'downloading'} onClick={() => void atlas().invoke('update:check')}
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-line/50 disabled:opacity-50">Check now</button>
            </div>
          </Row>
          {update?.notes && (update.status === 'available' || update.status === 'downloaded') && (
            <p className="whitespace-pre-line py-3 text-xs text-muted">{update.notes}</p>
          )}
          <Row label="Check for updates automatically" hint="On start-up and every 6 hours.">
            <input type="checkbox" checked={settings.updates.check} onChange={(e) => void patchSettings({ updates: { ...settings.updates, check: e.target.checked } })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
          </Row>
          <Row label="Download updates in the background" hint="Installing always waits for you and never interrupts a task.">
            <input type="checkbox" checked={settings.updates.autoDownload} onChange={(e) => void patchSettings({ updates: { ...settings.updates, autoDownload: e.target.checked } })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
          </Row>
          <Row label="Channel" hint="Beta also offers pre-releases.">
            <select value={settings.updates.channel} onChange={(e) => void patchSettings({ updates: { ...settings.updates, channel: e.target.value as 'stable' | 'beta' } })} className={input}>
              <option value="stable">Stable</option><option value="beta">Beta</option>
            </select>
          </Row>
        </Card>

        <Card title="System">
          {backend.status !== 'ready' || !info ? (
            <div className="py-3 text-sm text-muted">Backend: {backend.status}{backend.error ? ` — ${backend.error}` : ''}</div>
          ) : (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 py-3 text-sm">
              <dt className="text-muted">Display server</dt><dd>{info.session.kind}{info.session.xwayland ? ' (XWayland available)' : ''} · {info.session.desktop || 'unknown desktop'}</dd>
              <dt className="text-muted">Mouse / keyboard</dt><dd className={info.input.driver ? '' : 'text-danger'}>{info.input.driver ?? info.input.error}</dd>
              <dt className="text-muted">Accessibility (AT-SPI)</dt><dd className={info.atspi.available ? '' : 'text-warn'}>{info.atspi.available ? 'available' : info.atspi.reason}</dd>
              <dt className="text-muted">Global hotkeys</dt><dd className={info.hotkeys.source ? '' : 'text-danger'}>{info.hotkeys.source ? `${info.hotkeys.source} · ${info.hotkeys.kill_combo} = stop · ${info.hotkeys.ptt_combo} = talk` : info.hotkeys.error}</dd>
              {info.hotkeys.warning && <><dt /><dd className="text-xs text-warn">{info.hotkeys.warning}</dd></>}
              <dt className="text-muted">Kill switch</dt>
              <dd>{kill.active ? <button onClick={() => void atlas().invoke('kill:reset')} className="rounded-md bg-danger px-2 py-0.5 text-xs text-white">Triggered — re-arm</button> : 'armed'}</dd>
              <dt className="text-muted">Backend</dt><dd className="text-xs text-muted">v{info.version}{info.frozen ? ' (bundled)' : ' (source)'}</dd>
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
