import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../shared/types';
import { useUi } from '../store';
import { IconMic, IconTerminal, SparkMark } from './Icons';
import { Markdown } from './Markdown';
import { StepAccordion } from './StepAccordion';

function Bubble({ m, isLastStep, running }: { m: ChatMessage; isLastStep: boolean; running: boolean }) {
  if (m.kind === 'step' && m.step) {
    return <StepAccordion step={m.step} message={m.content} live={isLastStep && running} />;
  }
  if (m.role === 'system') {
    return <div className="mx-auto max-w-[85%] rounded-lg bg-line/40 px-3 py-1.5 text-center text-sm text-muted">{m.content}</div>;
  }
  if (m.role === 'user') {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-line bg-raised px-4 py-2.5 text-[15px] leading-relaxed shadow-soft">
          {m.via === 'voice' && <IconMic size={13} className="mr-1.5 inline text-accent" />}
          {m.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 animate-fade-in">
      <SparkMark size={20} className="mt-1 shrink-0 text-accent" />
      <div className="min-w-0 flex-1"><Markdown>{m.content}</Markdown></div>
    </div>
  );
}

const SUGGESTIONS = [
  'Open Firefox and search for today’s weather',
  'Find the 5 largest files in my Downloads folder',
  'Take a screenshot and describe what is on my screen',
  'Check which apps are using the most memory',
];

function EmptyState() {
  const send = useUi((s) => s.send);
  const name = useUi((s) => s.auth.email?.split('@')[0]);
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <SparkMark size={40} className="text-accent" />
      <h1 className="mt-5 font-serif text-4xl font-medium tracking-tight">{name ? `Hello, ${name}` : 'How can I help you today?'}</h1>
      <p className="mt-3 max-w-md text-muted">
        I can see your screen, move the mouse, type and run commands. Ask in text, or hold <span className="kbd">Alt</span>+<span className="kbd">Space</span> and just talk.
      </p>
      <div className="mt-8 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => void send(s)}
            className="rounded-xl border border-line bg-raised/60 px-4 py-3 text-left text-sm transition hover:border-accent/50 hover:bg-raised">
            <IconTerminal size={14} className="mr-2 inline text-accent" />{s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatView() {
  const chat = useUi((s) => s.chat);
  const running = useUi((s) => s.agent.status !== 'idle');
  const label = useUi((s) => s.agent.label);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages, label]);

  if (!chat || chat.messages.length === 0) return <EmptyState />;
  const lastStepId = [...chat.messages].reverse().find((m) => m.kind === 'step')?.id;

  return (
    <div ref={scroller} className="h-full overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        {chat.messages.map((m) => <Bubble key={m.id} m={m} isLastStep={m.id === lastStepId} running={running} />)}
        {running && (
          <div className="flex items-center gap-2 pl-8 text-sm text-muted">
            <span className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-pulse2 rounded-full bg-accent" style={{ animationDelay: `${i * 0.2}s` }} />)}</span>
            {label ?? 'Working…'}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
