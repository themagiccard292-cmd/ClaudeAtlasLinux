import { useEffect, useRef } from 'react';
import { atlas } from '../lib/atlas';
import { useUi } from '../store';
import { IconShield, SparkMark } from './Icons';

/**
 * First-launch screen. “Sign in with Claude Pro” asks the main process to embed the official
 * claude.ai/login page (WebContentsView on the persistent `persist:claude-pro` session) exactly over the
 * placeholder below. The moment the session cookie appears, main emits an `auth` event and App swaps
 * to the Agent UI.
 */
export function LoginView() {
  const { auth, loginRequested, set, patchSettings } = useUi();
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loginRequested) return;
    const el = slot.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      atlas().send('auth:loginBounds', { x: r.x, y: r.y, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      atlas().send('auth:loginBounds', null);
    };
  }, [loginRequested]);

  const begin = () => {
    set({ loginRequested: true });
    void atlas().invoke('auth:beginLogin');
  };
  const cancel = () => {
    set({ loginRequested: false });
    void atlas().invoke('auth:cancelLogin');
  };

  return (
    <div className="flex h-full items-center justify-center gap-12 px-10">
      <div className="max-w-md">
        <SparkMark size={44} className="text-accent" />
        <h1 className="mt-6 font-serif text-5xl font-medium leading-[1.1] tracking-tight">Your computer, with Claude at the wheel.</h1>
        <p className="mt-5 text-[17px] leading-relaxed text-muted">
          Sign in once with your Claude Pro account. Everything runs through your flat-rate subscription — no API key, no per-token billing.
        </p>
        {auth.error && <p role="alert" className="mt-4 rounded-lg bg-warn/15 px-3 py-2 text-sm text-warn">{auth.error}</p>}
        {!loginRequested ? (
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button onClick={begin} className="rounded-xl bg-accent px-6 py-3 text-[15px] font-medium text-accent-ink shadow-soft transition hover:opacity-90">
              Sign in with Claude Pro
            </button>
            <button onClick={() => void patchSettings({ bridgeMode: 'cli' })} className="rounded-xl px-4 py-3 text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
              Use the local Claude CLI instead
            </button>
          </div>
        ) : (
          <button onClick={cancel} className="mt-8 rounded-xl border border-line px-5 py-2.5 text-sm text-muted hover:text-ink">← Back</button>
        )}
        <p className="mt-8 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <IconShield size={15} className="mt-0.5 shrink-0" />
          You sign in on the official claude.ai page inside this app. Your password never touches Claude OS Agent, and the session cookie stays in the app’s private browser profile.
        </p>
      </div>

      <div className={`overflow-hidden rounded-2xl border border-line bg-raised shadow-soft transition-all ${loginRequested ? 'h-[min(640px,84vh)] w-[460px] opacity-100' : 'h-0 w-0 border-0 opacity-0'}`}>
        <div ref={slot} className="h-full w-full">
          {!window.navigator.userAgent.includes('Electron') && <p className="p-6 text-sm text-muted">The official claude.ai sign-in page appears here.</p>}
        </div>
      </div>
    </div>
  );
}
