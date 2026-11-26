import { useEffect } from 'react';
import { isHudRoute } from './lib/atlas';
import { useUi } from './store';
import { Banners, Toasts } from './components/Banners';
import { ChatView } from './components/ChatView';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Hud } from './components/Hud';
import { IconSidebar } from './components/Icons';
import { LoginView } from './components/LoginView';
import { PromptBar } from './components/PromptBar';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';

/** `dark` follows prefers-color-scheme; the main process maps Settings → nativeTheme.themeSource. */
function useTheme(): void {
  useEffect(() => {
    if (isHudRoute()) {
      // The HUD pill is always dark (it floats over arbitrary apps), regardless of the system theme.
      document.documentElement.classList.add('dark');
      return;
    }
    const q = new URLSearchParams(window.location.search);
    if (q.get('theme')) return; // explicit override used by the mock / screenshots
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
}

function Shell() {
  const { chat, agent, sidebarOpen, set, settingsOpen, confirm, hud } = useUi();
  const bridgeMode = useUi((s) => s.settings.bridgeMode);
  const auth = useUi((s) => s.auth);
  const loaded = useUi((s) => s.loaded);

  useEffect(() => { void useUi.getState().init(); }, []);

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  if (auth.status !== 'signed_in' && bridgeMode === 'web') {
    return <><LoginView /><Toasts /></>;
  }

  return (
    <div className="flex h-full">
      {sidebarOpen && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <button onClick={() => set({ sidebarOpen: !sidebarOpen })} aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={sidebarOpen}
            className="rounded-lg p-1.5 text-muted hover:bg-line/50 hover:text-ink"><IconSidebar size={18} /></button>
          <h1 className="min-w-0 flex-1 truncate font-serif text-[17px] font-medium">{chat?.title ?? 'Claude OS Agent'}</h1>
          {agent.status !== 'idle' && (
            <span className="flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent">
              <span className="h-1.5 w-1.5 animate-pulse2 rounded-full bg-accent" />
              {agent.status === 'waiting_confirmation' ? 'Needs approval' : agent.status === 'paused' ? 'Paused' : `Step ${agent.step}/${agent.maxSteps}`}
            </span>
          )}
          {hud && <span className="text-xs text-muted">HUD active</span>}
        </header>
        <Banners />
        <div className="min-h-0 flex-1"><ChatView /></div>
        <PromptBar />
      </main>
      {settingsOpen && <SettingsPanel />}
      {confirm && <ConfirmDialog req={confirm} />}
      <Toasts />
    </div>
  );
}

export default function App() {
  useTheme();
  return isHudRoute() ? <Hud /> : <Shell />;
}
