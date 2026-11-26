import { useEffect, useRef, useState } from 'react';
import { atlas } from '../lib/atlas';
import { liveBus } from '../lib/liveBus';
import { useUi } from '../store';
import { IconBolt, IconRefresh, IconX } from './Icons';

interface Ripple {
  id: number;
  x: number;
  y: number;
  kind: string;
  label?: string | null;
}

/** Arrow pointer with the tip at (0,0). Terracotta fill + white outline so it reads on any background. */
function AgentCursor({ label, busy, labelRef }: { label: string; busy: boolean; labelRef: React.RefObject<HTMLDivElement> }) {
  return (
    <>
      <svg width="30" height="34" viewBox="0 0 30 34" className="drop-shadow-[0_2px_6px_rgba(0,0,0,.45)]" aria-hidden="true">
        <path d="M2 2 L2 26 L8.5 20.5 L13 31 L18 28.8 L13.5 18.6 L22 18 Z" fill="#D97757" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <div ref={labelRef} className={`absolute left-5 top-6 flex max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded-full bg-[#D97757] px-2.5 py-1 text-[11px] font-semibold leading-none text-[#1F1E1D] shadow-lg ${busy ? '' : 'opacity-80'}`}>
        <IconBolt size={11} />
        <span className="truncate">{label}</span>
      </div>
    </>
  );
}

/**
 * Live view of the sandbox desktop: a ~15 fps stream, the agent's mouse pointer gliding over it, ripples on clicks
 * and chips for typing / shortcuts — so you can watch Claude work, not read about it afterwards.
 */
export function LiveView() {
  const { sandbox, agent, set, settings } = useUi();
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);
  const [size, setSize] = useState({ w: 16, h: 9 });
  const [hasFrame, setHasFrame] = useState(false);
  const [ended, setEnded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [chip, setChip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastAt = useRef(0);
  const nextId = useRef(1);

  useEffect(() => {
    const off = liveBus.onFrame((e) => {
      if (e.ended) {
        setEnded(true);
        setFresh(false);
        return;
      }
      setEnded(false);
      lastAt.current = performance.now();
      if (e.pointer && cursor.current) {
        cursor.current.style.left = `${e.pointer[0] * 100}%`;
        cursor.current.style.top = `${e.pointer[1] * 100}%`;
        cursor.current.style.opacity = '1';
        // keep the name tag inside the screen: flip it left / above when the pointer is near an edge
        const tag = labelRef.current;
        if (tag) {
          const nearRight = e.pointer[0] > 0.66;
          tag.style.left = nearRight ? 'auto' : '1.25rem';
          tag.style.right = nearRight ? '1.4rem' : 'auto';
          tag.style.top = e.pointer[1] > 0.88 ? '-1.6rem' : '1.5rem';
        }
      }
      if (e.jpeg && canvas.current) {
        const seq = e.seq;
        // NB: no fetch('data:…') here — the production CSP (connect-src 'self') blocks it.
        const bin = atob(e.jpeg);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        void createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
          .then((bmp) => {
            if (seq < lastSeq.current || !canvas.current) return bmp.close();
            lastSeq.current = seq;
            const c = canvas.current;
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width;
              c.height = bmp.height;
              setSize({ w: bmp.width, h: bmp.height });
            }
            c.getContext('2d')!.drawImage(bmp, 0, 0);
            bmp.close();
            setHasFrame(true);
          })
          .catch(() => undefined);
      }
    });
    const offFx = liveBus.onFx(({ fx }) => {
      if (fx.target !== 'sandbox') return;
      if (fx.x !== undefined && fx.y !== undefined && fx.kind !== 'type' && fx.kind !== 'hotkey') {
        const r: Ripple = { id: nextId.current++, x: fx.x, y: fx.y, kind: fx.kind, label: fx.label };
        setRipples((cur) => [...cur.slice(-6), r]);
        setTimeout(() => setRipples((cur) => cur.filter((c) => c.id !== r.id)), 900);
      }
      if (fx.to_x !== undefined && fx.to_y !== undefined) {
        const r: Ripple = { id: nextId.current++, x: fx.to_x, y: fx.to_y, kind: 'drop' };
        setRipples((cur) => [...cur.slice(-6), r]);
        setTimeout(() => setRipples((cur) => cur.filter((c) => c.id !== r.id)), 900);
      }
      if (fx.kind === 'type' || fx.kind === 'hotkey') {
        setChip(fx.kind === 'type' ? `⌨  ${fx.label ?? ''}` : `⌘  ${fx.label ?? ''}`);
        setTimeout(() => setChip((c) => (c && c.includes(fx.label ?? '') ? null : c)), 1600);
      }
    });
    const tick = setInterval(() => {
      const f = performance.now() - lastAt.current < 2500;
      setFresh(f);
    }, 500);
    return () => {
      off();
      offFx();
      clearInterval(tick);
    };
  }, []);

  useEffect(() => setBusy(agent.status === 'running'), [agent.status]);

  const start = () => void atlas().invoke('sandbox:start').catch((e: Error) => useUi.getState().toast('error', e.message));
  const reset = () => void atlas().invoke('sandbox:reset').then(() => setHasFrame(false)).catch((e: Error) => useUi.getState().toast('error', e.message));
  const live = fresh && !ended;
  const label = agent.status !== 'idle' ? (agent.label ?? 'Working…') : 'Claude';

  return (
    <aside aria-label="Live view" className="flex w-[46%] min-w-[360px] max-w-[760px] shrink-0 flex-col border-l border-line bg-surface max-[979px]:hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className={`h-2 w-2 rounded-full ${live ? 'animate-pulse2 bg-ok' : 'bg-muted/50'}`} />
        <h2 className="font-serif text-[15px] font-medium">{live ? 'Live' : hasFrame ? 'Paused' : 'Sandbox desktop'}</h2>
        <span className="text-xs text-muted">{sandbox?.running ? `${sandbox.width}×${sandbox.height} · ${sandbox.display}` : 'not running'}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={reset} disabled={agent.status !== 'idle'} title="Restart the sandbox (closes its apps)" aria-label="Reset sandbox"
            className="rounded-lg p-1.5 text-muted hover:bg-line/60 hover:text-ink disabled:opacity-40"><IconRefresh size={16} /></button>
          <button onClick={() => set({ liveOpen: false })} title="Hide live view" aria-label="Hide live view"
            className="rounded-lg p-1.5 text-muted hover:bg-line/60 hover:text-ink"><IconX size={16} /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <div className="relative w-full overflow-hidden rounded-xl border border-line bg-[#2f2e2b] shadow-soft" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
          <canvas ref={canvas} width={size.w} height={size.h} className="block h-full w-full" />
          {hasFrame && (
            <>
              {ripples.map((r) => (
                <span key={r.id} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }}>
                  <span className={`block h-14 w-14 animate-[ripple_.8s_ease-out_forwards] rounded-full border-[3px] ${r.kind === 'right_click' ? 'border-sky-400' : 'border-[#D97757]'} bg-[#D97757]/25`} />
                </span>
              ))}
              <div ref={cursor} className="pointer-events-none absolute opacity-0 transition-[left,top] duration-100 ease-linear" style={{ left: '50%', top: '50%' }}>
                <AgentCursor label={label} busy={busy} labelRef={labelRef} />
              </div>
              {chip && (
                <div className="absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-lg bg-black/75 px-3 py-1.5 font-mono text-xs text-white">{chip}</div>
              )}
            </>
          )}
          {!hasFrame && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-xs text-sm text-white/80">
                {sandbox?.available === false
                  ? sandbox.reason
                  : 'Claude works on its own private desktop, so your screen stays free. It appears here the moment a task starts.'}
              </p>
              {sandbox?.available !== false && (
                <button onClick={start} className="rounded-lg bg-[#D97757] px-4 py-2 text-sm font-medium text-[#1F1E1D] hover:opacity-90">Start sandbox now</button>
              )}
            </div>
          )}
        </div>
        <p className="max-w-md text-center text-xs text-muted">
          {settings.desktopMode === 'sandbox'
            ? 'You are watching a private virtual desktop. Press Esc twice or Stop at any time.'
            : 'Switch to “Sandbox” under the prompt box to watch Claude here.'}
        </p>
      </div>
    </aside>
  );
}
