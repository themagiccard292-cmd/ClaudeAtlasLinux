import { useState } from 'react';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { IconAlert, IconX } from './Icons';

function Banner({ tone, children, action }: { tone: 'danger' | 'warn' | 'info'; children: React.ReactNode; action?: React.ReactNode }) {
  const cls = { danger: 'bg-danger/12 text-danger', warn: 'bg-warn/15 text-warn', info: 'bg-line/50 text-muted' }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex items-center gap-2.5 px-4 py-2 text-sm ${cls}`}>
      <IconAlert size={16} className="shrink-0" /><div className="min-w-0 flex-1">{children}</div>{action}
    </div>
  );
}

export function Banners() {
  const { kill, backend, loaded } = useUi();
  const [dismissed, setDismissed] = useState(false);
  const warn = backend.info?.hotkeys.warning;
  const driverErr = backend.info && !backend.info.input.driver ? backend.info.input.error : null;

  return (
    <>
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
