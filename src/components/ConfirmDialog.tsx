import { useEffect } from 'react';
import type { ConfirmRequest } from '../../shared/types';
import { actionTitle } from '../lib/format';
import { atlas } from '../lib/atlas';
import { IconShield } from './Icons';

export function answer(id: string, approved: boolean): void {
  void atlas().invoke('agent:confirm', { id, approved });
}

export function ConfirmBody({ req }: { req: ConfirmRequest }) {
  const a = req.action;
  return (
    <>
      <div className="flex items-center gap-2 text-warn">
        <IconShield size={18} />
        <h2 className="font-serif text-lg font-medium text-ink">Approve this action?</h2>
      </div>
      <p className="mt-2 text-sm">{req.reason}</p>
      <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-2.5 font-mono text-xs">
        {a.action === 'bash' ? <><span className="text-accent">$ </span>{a.command}</> : actionTitle(a)}
      </pre>
      {a.reason && <p className="mt-2 text-xs text-muted">Claude says: {a.reason}</p>}
    </>
  );
}

/** Modal shown in the main window. (The HUD renders the same content inline.) */
export function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(req.id, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.id]);

  return (
    <div role="alertdialog" aria-modal="true" aria-label="Approval required" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-md animate-fade-in rounded-2xl border border-line bg-surface p-5 shadow-soft">
        <ConfirmBody req={req} />
        <p className="mt-3 text-xs text-muted">You can also say “approve” or “deny”.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={() => answer(req.id, false)} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-line/50">Deny</button>
          <button onClick={() => answer(req.id, true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90">Approve</button>
        </div>
      </div>
    </div>
  );
}
