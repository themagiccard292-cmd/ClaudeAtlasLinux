import { useState } from 'react';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { IconAlert, IconRefresh, IconX } from './Icons';

function Banner({ tone, children, action, icon }: { tone: 'danger' | 'warn' | 'info'; children: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  const cls = { danger: 'bg-danger/12 text-danger', warn: 'bg-warn/15 text-warn', info: 'bg-line/50 text-muted' }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex items-center gap-2.5 px-4 py-2 text-sm ${cls}`}>
      {icon ?? <IconAlert size={16} className="shrink-0" />}<div className="min-w-0 flex-1">{children}</div>{action}
    </div>
  );
}

function UpdateBanner() {
  const update = useUi((s) => s.update);
  const busy = useUi((s) => s.agent.status !== 'idle');
  const toast = useUi((s) => s.toast);
  const [later, setLater] = useState<string | null>(null);
  if (!update || update.status === 'disabled' || later === update.version) return null;

  const run = (p: Promise<unknown>) => void p.catch((e: Error) => toast('error', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  const btn = 'rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-50';

  if (update.status === 'available') {
    return (
      <Banner tone="info" icon={<IconRefresh size={16} className="shrink-0 text-accent" />} action={<button className={btn} onClick={() => run(atlas().invoke('update:download'))}>Download</button>}>
        <strong>Version {update.version}</strong> is available.
      </Banner>
    );
  }
  if (update.status === 'downloading') {
    return (
      <Banner tone="info" icon={<IconRefresh size={16} className="shrink-0 text-accent" />}>
        Downloading version {update.version}… <span className="font-mono">{update.progress ?? 0}%</span>
        <span className="ml-3 inline-block h-1.5 w-40 overflow-hidden rounded-full bg-line align-middle">
          <span className="block h-full bg-accent transition-all" style={{ width: `${update.progress ?? 0}%` }} />
        </span>
      </Banner>
    );
  }
  if (update.status === 'downloaded') {
    return (
      <Banner tone="info" icon={<IconRefresh size={16} className="shrink-0 text-accent" />} action={
        <span className="flex items-center gap-2">
          <button onClick={() => setLater(update.version ?? null)} className="rounded-md px-2 py-1 text-xs hover:bg-line/60">Later</button>
          <button className={btn} disabled={busy} title={busy ? 'Finish or stop the current task first' : undefined}
            onClick={() => run(atlas().invoke('update:install'))}>Restart to update</button>
        </span>}>
        <strong>Version {update.version}</strong> is ready.{update.method === 'deb' ? ' You will be asked for your password.' : ''}
        {busy && <span className="ml-2 text-xs">(waiting for the current task to finish)</span>}
      </Banner>
    );
  }
  return null;
}

export function Banners() {
  const { kill, backend, loaded } = useUi();
  const [dismissed, setDismissed] = useState(false);
  const warn = backend.info?.hotkeys.warning;
  const driverErr = backend.info && !backend.info.input.driver ? backend.info.input.error : null;

  return (
    <>
      <UpdateBanner />
      {kill.active && (
        <Banner tone="danger" action={
          <button onClick={() => void atlas().invoke('kill:reset')} className="rounded-md bg-danger px-3 py-1 text-xs font-medium text-white hover:opacity-90">Re-arm</button>}>
          <strong>Emergency stop</strong> — all mouse, keyboard and shell activity was halted{kill.source ? ` (${kill.source})` : ''}. Re-arm to let Claude act again.
        </Banner>
      )}
      {loaded && backend.status === 'starting' && <Banner tone="info">Starting the OS-automation backend… (first launch unpacks the bundled engine)</Banner>}
      {backend.status === 'error' && <Banner tone="danger">OS-automation backend problem: {backend.error}</Banner>}
      {driverErr && <Banner tone="warn">No mouse/keyboard driver: {driverErr}</Banner>}
      {warn && !dismissed && (
        <Banner tone="warn" action={<button onClick={() => setDismissed(true)} aria-label="Dismiss" className="rounded p-1 hover:bg-warn/20"><IconX size={14} /></button>}>{warn}</Banner>
      )}
    </>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useUi();
  return (
    <div className="pointer-events-none fixed bottom-24 right-5 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`pointer-events-auto animate-fade-in rounded-xl border px-3.5 py-2.5 text-sm shadow-soft ${t.level === 'error' ? 'border-danger/40 bg-surface text-danger' : t.level === 'warn' ? 'border-warn/40 bg-surface text-warn' : 'border-line bg-surface'}`}
          onClick={() => dismissToast(t.id)}>{t.message}</div>
      ))}
    </div>
  );
}
