import { useEffect, useRef, useState } from 'react';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { AudioVisualizer } from './AudioVisualizer';
import { IconBolt, IconMic, IconSend, IconStop } from './Icons';

export function PromptBar() {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const { mode, set, send, agent, voice, backend, kill, settings, patchSettings } = useUi();
  const running = agent.status !== 'idle';
  const listening = voice.state === 'listening' || voice.state === 'hearing';
  const speaking = voice.state === 'speaking';
  const backendOk = backend.status === 'ready';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void send(t);
  };

  const ptt = (down: boolean) => void atlas().invoke('voice:ptt', down).catch((e: Error) => useUi.getState().toast('error', e.message));

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      <div className={`rounded-2xl border bg-raised shadow-soft transition-colors focus-within:border-accent/60 ${listening ? 'border-accent' : 'border-line'}`}>
        {listening || speaking || voice.state === 'transcribing' ? (
          <div className="flex items-center gap-3 px-4 py-3.5">
            <AudioVisualizer width={220} height={30} bars={40} active={listening || speaking} className="text-accent" />
            <span className="text-sm text-muted">
              {voice.state === 'transcribing' ? 'Transcribing…' : speaking ? 'Claude is speaking — talk to interrupt' : voice.state === 'hearing' ? 'Hearing you…' : 'Listening — release to send'}
            </span>
          </div>
        ) : (
          <textarea
            ref={ref}
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={running ? 'Interrupt with a new instruction…' : mode === 'agent' ? 'Tell Claude what to do on your computer…' : 'Message Claude…'}
            className="block max-h-[200px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-muted"
          />
        )}
        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
          <div className="flex items-center gap-1.5">
            <div role="group" aria-label="Mode" className="flex rounded-lg border border-line p-0.5 text-xs">
              {(['agent', 'chat'] as const).map((m) => (
                <button key={m} onClick={() => set({ mode: m })} aria-pressed={mode === m}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium capitalize transition ${mode === m ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
                  {m === 'agent' && <IconBolt size={12} />}{m}
                </button>
              ))}
            </div>
            {mode === 'agent' && (
              <div role="group" aria-label="Which desktop" className="flex rounded-lg border border-line p-0.5 text-xs">
                {([['sandbox', 'Sandbox', 'Claude works on a private virtual desktop you watch live'], ['real', 'My desktop', 'Claude drives your real screen (the window hides while it works)']] as const).map(([m, label, tip]) => (
                  <button key={m} title={tip} disabled={running} onClick={() => void patchSettings({ desktopMode: m })} aria-pressed={settings.desktopMode === m}
                    className={`rounded-md px-2.5 py-1 font-medium transition disabled:opacity-60 ${settings.desktopMode === m ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); ptt(true); }}
              onPointerUp={() => ptt(false)}
              onPointerCancel={() => ptt(false)}
              title="Hold to talk (or hold Alt+Space anywhere)"
              aria-label="Hold to talk"
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${listening ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-line/60 hover:text-ink'}`}>
              <IconMic size={18} />
            </button>
            {running ? (
              <button onClick={() => void atlas().invoke('agent:stop')} aria-label="Stop"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-danger text-white transition hover:opacity-90">
                <IconStop size={16} />
              </button>
            ) : (
              <button onClick={submit} disabled={!text.trim() || (mode === 'agent' && (!backendOk || kill.active))} aria-label="Send"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-ink transition enabled:hover:opacity-90 disabled:opacity-35">
                <IconSend size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-muted">
        Hold <span className="kbd">Alt</span>+<span className="kbd">Space</span> to talk · press <span className="kbd">Esc</span> <span className="kbd">Esc</span> to emergency-stop · Claude can make mistakes
      </p>
    </div>
  );
}
