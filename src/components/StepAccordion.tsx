import { useState } from 'react';
import type { ActionRecord, StepRecord } from '../../shared/types';
import { actionTitle, statusTone } from '../lib/format';
import {
  IconBolt, IconChevron, IconClock, IconCursor, IconKeyboard, IconScroll, IconShield, IconTerminal, IconTree,
} from './Icons';

const TONE = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', muted: 'text-muted' } as const;

function ActionIcon({ type }: { type: string }) {
  if (type === 'bash') return <IconTerminal size={15} />;
  if (type === 'type' || type === 'hotkey') return <IconKeyboard size={15} />;
  if (type === 'scroll') return <IconScroll size={15} />;
  if (type === 'wait') return <IconClock size={15} />;
  if (type.startsWith('atspi')) return <IconTree size={15} />;
  return <IconCursor size={15} />;
}

function StatusDot({ status }: { status: ActionRecord['status'] }) {
  const running = status === 'running' || status === 'awaiting_approval';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${TONE[statusTone(status)]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${running ? 'animate-pulse2' : ''}`} />
      {status.replace('_', ' ')}
    </span>
  );
}

/** Screenshot Claude saw, with the coordinates of each action drawn on top. */
function Screenshot({ step }: { step: StepRecord }) {
  if (!step.screenshot) return null;
  const w = step.shotWidth ?? 1280;
  const h = step.shotHeight ?? 720;
  const marks = step.actions.filter((a) => a.action.x !== undefined && a.action.y !== undefined);
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-black/5" style={{ aspectRatio: `${w} / ${h}` }}>
      <img src={step.screenshot} alt={`Screenshot for step ${step.step}`} className="h-full w-full object-cover" />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {marks.map((a, i) => {
          const { x = 0, y = 0, to_x, to_y } = a.action;
          const r = Math.max(12, w / 55);
          return (
            <g key={a.id}>
              {to_x !== undefined && to_y !== undefined && (
                <line x1={x} y1={y} x2={to_x} y2={to_y} stroke="rgb(217 119 87)" strokeWidth={r / 4} strokeDasharray={`${r / 2} ${r / 3}`} />
              )}
              <circle cx={x} cy={y} r={r} fill="rgb(217 119 87 / 0.25)" stroke="rgb(217 119 87)" strokeWidth={r / 6} />
              <circle cx={x} cy={y} r={r / 6} fill="rgb(217 119 87)" />
              <text x={x + r * 1.15} y={y - r * 0.6} fontSize={r * 1.1} fontWeight={700} fill="#fff" stroke="rgb(0 0 0 / .6)" strokeWidth={r / 5} paintOrder="stroke">{i + 1}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ActionRow({ rec, index }: { rec: ActionRecord; index: number }) {
  const a = rec.action;
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted"><ActionIcon type={a.action} /></span>
        <span className="font-medium">{index + 1}.</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={actionTitle(a)}>{actionTitle(a)}</span>
        <StatusDot status={rec.status} />
      </div>
      {a.target && <div className="mt-1 pl-7 text-xs text-muted">Target: {a.target}</div>}
      {rec.screen && (
        <div className="mt-1 pl-7 text-xs text-muted">
          Clicked screen coordinates <span className="font-mono text-ink">({rec.screen.x}, {rec.screen.y})</span>
          {rec.screen.to_x !== undefined && <> → <span className="font-mono text-ink">({rec.screen.to_x}, {rec.screen.to_y})</span></>}
        </div>
      )}
      {a.action === 'bash' && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-bg p-2 font-mono text-xs leading-relaxed"><span className="text-accent">$ </span>{a.command}</pre>
      )}
      {rec.output && (rec.output.stdout || rec.output.stderr) && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-bg p-2 font-mono text-xs leading-relaxed">
          {rec.output.stdout}
          {rec.output.stderr && <span className="text-danger">{rec.output.stderr}</span>}
        </pre>
      )}
      {rec.output?.exit_code !== undefined && rec.output.exit_code !== 0 && (
        <div className="mt-1 pl-7 text-xs text-danger">exit code {rec.output.exit_code}{rec.output.timed_out ? ' (timed out)' : ''}</div>
      )}
      {rec.risk && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-7 text-xs text-warn"><IconShield size={13} /> {rec.risk.reason}</div>
      )}
      {rec.status === 'error' && rec.message && <div className="mt-1 pl-7 text-xs text-danger">{rec.message}</div>}
    </li>
  );
}

export function StepAccordion({ step, message, live }: { step: StepRecord; message: string; live: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const working = step.actions.some((a) => a.status === 'running' || a.status === 'awaiting_approval');
  const failed = step.actions.some((a) => a.status === 'error' || a.status === 'denied' || a.status === 'killed');

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-line bg-raised/60">
      <button onClick={() => setUserOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-line/30">
        <IconChevron size={15} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${working ? 'bg-accent/15 text-accent' : failed ? 'bg-danger/15 text-danger' : 'bg-ok/15 text-ok'}`}>
          <IconBolt size={12} />
        </span>
        <span className="text-sm font-medium">Step {step.step}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{message || step.thought || step.actions.map((a) => a.action.action).join(', ')}</span>
        <span className="flex shrink-0 gap-1">
          {step.actions.slice(0, 4).map((a) => (
            <span key={a.id} className={`rounded-full border border-line px-1.5 py-0.5 ${TONE[statusTone(a.status)]}`} title={a.status}>
              <ActionIcon type={a.action.action} />
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3.5 py-3">
          {step.thought && <p className="text-sm italic text-muted">“{step.thought}”</p>}
          {step.vision && (
            <p className="text-xs text-muted">
              Claude received: <span className={step.vision.kind === 'none' ? 'font-medium text-ok' : 'font-medium text-accent'}>
                {step.vision.kind === 'none' ? 'text only (no image)' : step.vision.kind === 'strip' ? 'text + motion strip' : 'text + one frame'}</span>
              {step.vision.meta && <> · {step.vision.meta.ocr_lines ?? 0} text lines, {step.vision.meta.elements ?? 0} controls</>}
              <span className="ml-1 opacity-70">(the preview below is for you)</span>
            </p>
          )}
          <Screenshot step={step} />
          {step.changed === false && <p className="text-xs text-warn">The screen did not change after the previous step.</p>}
          <ul className="space-y-2">{step.actions.map((a, i) => <ActionRow key={a.id} rec={a} index={i} />)}</ul>
        </div>
      )}
    </div>
  );
}
