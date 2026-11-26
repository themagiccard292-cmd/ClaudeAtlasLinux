import { useEffect } from 'react';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { AudioVisualizer } from './AudioVisualizer';
import { ConfirmBody, answer } from './ConfirmDialog';
import { IconHand, SparkMark } from './Icons';

/** The floating “Mini-HUD” pill (separate frameless always-on-top window, route `#/hud`). */
export function Hud() {
  const { agent, voice, confirm, init } = useUi();

  useEffect(() => {
    document.body.classList.add('hud');
    void init();
    return () => document.body.classList.remove('hud');
  }, [init]);

  const listening = voice.state === 'listening' || voice.state === 'hearing' || voice.state === 'speaking';
  const paused = agent.status === 'paused';
  const label = agent.label ?? (paused ? 'Paused' : 'Claude is working…');

  return (
    <div className="flex h-screen flex-col justify-end gap-2 p-2 text-[#F0EEE6]">
      {confirm && (
        <div role="alertdialog" aria-label="Approval required" className="no-drag max-h-[220px] overflow-y-auto rounded-2xl border border-white/10 bg-[#262624]/95 p-4 shadow-pill backdrop-blur">
          <ConfirmBody req={confirm} />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => answer(confirm.id, false)} className="rounded-lg border border-white/20 px-4 py-1.5 text-sm hover:bg-white/10">Deny</button>
            <button onClick={() => answer(confirm.id, true)} className="rounded-lg bg-[#D97757] px-4 py-1.5 text-sm font-medium text-[#1F1E1D] hover:opacity-90">Approve</button>
          </div>
        </div>
      )}
      <div className="drag flex h-14 shrink-0 items-center gap-3 rounded-full border border-white/10 bg-[#262624]/95 pl-4 pr-2 shadow-pill backdrop-blur">
        <SparkMark size={20} className={`shrink-0 text-[#D97757] ${paused ? '' : 'animate-pulse2'}`} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium" title={label}>{label}</div>
          <div className="text-[11px] text-white/55">
            {agent.step > 0 ? `Step ${agent.step} of ${agent.maxSteps}` : 'Starting'} · <span className="font-mono">Esc Esc</span> to halt
          </div>
        </div>
        <AudioVisualizer width={84} height={26} bars={16} active={listening} className="shrink-0 text-[#D97757]" />
        <button onClick={() => void atlas().invoke('agent:takeover')}
          className="no-drag flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-[#E5564B] px-4 text-[13px] font-bold tracking-wide text-white transition hover:brightness-110 active:scale-95">
          <IconHand size={16} /> STOP / TAKE OVER
        </button>
      </div>
    </div>
  );
}
