import { randomUUID } from 'node:crypto';
import type { AtlasEvent } from '../../shared/ipc';
import type {
  ActionRecord, AgentAction, AgentReply, AgentState, BackendInfo, Chat, ChatMessage, ImageKind, PerceptionMeta, SandboxState, Settings, StepRecord,
} from '../../shared/types';
import type { BackendClient } from '../backend/client';
import { thumbnailDataUrl } from '../bridge/imageUtil';
import { BridgeError, type ClaudeBridge } from '../bridge/types';
import type { Store } from '../store';
import type { HudMask } from '../windows';
import { ParseError, parseAgentReply } from './parser';
import { buildFollowUp, buildFormatReminder, buildInitialPrompt, type PromptEnv } from './prompt';
import { parseVoiceConfirmation } from './voiceConfirm';

/** What the perception engine handed us for one turn: text first, an image only when it earned its place. */
interface Observation {
  text: string;
  /** Sent to Claude only when present (motion strip, or a frame for content text cannot describe). */
  image?: Buffer;
  imageKind: ImageKind;
  /** Small preview for the chat UI (never sent to Claude). */
  thumb: Buffer;
  width: number;
  height: number;
  changed: boolean | null;
  meta: PerceptionMeta;
}

interface ExecResult {
  ok: boolean;
  message?: string;
  error?: string;
  killed?: boolean;
  needs_confirmation?: boolean;
  risk?: { reason: string; category: string };
  screen?: { x: number; y: number; to_x?: number; to_y?: number };
  output?: { stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean };
  duration_ms?: number;
}

export interface RunnerDeps {
  backend: () => BackendClient | null;
  backendInfo: () => BackendInfo | undefined;
  getBridge: () => ClaudeBridge;
  store: Store;
  settings: () => Settings;
  emit: (e: AtlasEvent) => void;
  enterHud: () => HudMask | null;
  exitHud: () => void;
  hudMask: () => HudMask | null;
  setHudExpanded: (expanded: boolean) => void;
  onAuthProblem: () => void;
  log: (m: string) => void;
}

class StoppedError extends Error {
  constructor(public reason: 'user' | 'kill') {
    super(reason === 'kill' ? 'Emergency stop (Esc Esc)' : 'Stopped by user');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_PARSE_RETRIES = 2;

export class AgentRunner {
  private state: AgentState = { status: 'idle', step: 0, maxSteps: 0 };
  private abort: AbortController | null = null;
  private stopReason: 'user' | 'kill' = 'user';
  private pauseGate: Promise<void> | null = null;
  private releasePause: (() => void) | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private interjections: string[] = [];
  private confirms = new Map<string, { resolve: (ok: boolean) => void; chatId: string }>();
  private expectingOwnKill = false;
  /** Which desktop the current task drives. */
  private target: 'real' | 'sandbox' = 'real';
  private streamStopTimer: NodeJS.Timeout | null = null;
  /** Claude asked to `look`: attach a full frame to the next observation. */
  private wantLook = false;

  constructor(private readonly d: RunnerDeps) {}

  // ----------------------------------------------------------------- public
  getState(): AgentState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status !== 'idle';
  }

  hasPendingConfirmation(): boolean {
    return this.confirms.size > 0;
  }

  start(req: { chatId: string; text: string; mode: 'agent' | 'chat'; via?: 'text' | 'voice' }): void {
    const text = req.text.trim();
    if (!text) return;
    if (this.isRunning()) {
      this.interject(text); // typing while the agent works = interrupt with a new instruction
      return;
    }
    const chat = this.d.store.getChat(req.chatId);
    if (!chat) throw new Error('Chat not found');

    this.abort = new AbortController();
    this.stopReason = 'user';
    this.interjections = [];
    this.setState({ status: 'running', chatId: chat.id, step: 0, maxSteps: this.d.settings().maxSteps, label: 'Starting…' });
    this.addMessage(chat, { role: 'user', kind: 'text', content: text, via: req.via ?? 'text' });
    if (chat.messages.length === 1) this.retitle(chat, text);

    void this.run(chat, text, req.mode).catch((e) => this.d.log(`runner crashed: ${e instanceof Error ? e.stack : e}`));
  }

  /** User pressed STOP / TAKE OVER. */
  async stop(reason: 'user' | 'kill' = 'user'): Promise<void> {
    if (!this.isRunning()) return;
    this.stopReason = reason;
    this.abort?.abort();
    this.releaseAllConfirms(false);
    this.resume();
    if (reason === 'user') {
      // halt any in-flight mouse/keyboard/bash immediately, then re-arm once the loop unwinds
      this.expectingOwnKill = true;
      await this.d.backend()?.call('kill.trigger', { source: 'stop-button' }).catch(() => undefined);
    }
  }

  /** Backend reported the global kill switch (Esc Esc). */
  onKillTriggered(source: string): void {
    if (source === 'stop-button' && this.expectingOwnKill) return; // our own STOP, not an emergency
    this.d.emit({ type: 'kill', active: true, source });
    void this.stop('kill');
  }

  pause(reason: string): void {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_confirmation') return;
    if (this.pauseGate) return;
    this.pauseGate = new Promise<void>((r) => (this.releasePause = r));
    this.setState({ status: 'paused', label: `Paused (${reason}) — listening…` });
    // If nothing comes of the interruption (background noise), carry on by ourselves.
    this.pauseTimer = setTimeout(() => this.resume(), 15_000);
  }

  resume(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this.releasePause?.();
    this.pauseGate = null;
    this.releasePause = null;
    if (this.state.status === 'paused') this.setState({ status: 'running', label: undefined });
  }

  /** New instruction from the user mid-task (typed or spoken). Replaces the pending plan. */
  interject(text: string): void {
    this.interjections.push(text.trim());
    const chat = this.state.chatId ? this.d.store.getChat(this.state.chatId) : null;
    if (chat) this.addMessage(chat, { role: 'user', kind: 'text', content: text.trim(), via: 'text' });
    this.resume();
  }

  /** Spoken answer routing while a confirmation is pending. Returns true if consumed. */
  handleVoiceAnswer(text: string): boolean {
    if (!this.confirms.size) return false;
    const decision = parseVoiceConfirmation(text);
    if (!decision) {
      void this.d.backend()?.call('voice.speak', { text: 'Please say approve or deny.' }).catch(() => undefined);
      void this.d.backend()?.call('voice.listen_once').catch(() => undefined);
      return true;
    }
    for (const id of [...this.confirms.keys()]) this.confirm(id, decision === 'approve');
    return true;
  }

  confirm(id: string, approved: boolean): void {
    const w = this.confirms.get(id);
    if (!w) return;
    this.confirms.delete(id);
    if (!this.confirms.size) {
      this.d.emit({ type: 'confirm', request: null });
      this.d.setHudExpanded(false);
    }
    w.resolve(approved);
  }

  // ---------------------------------------------------------------- internals
  private setState(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    this.d.emit({ type: 'agent', state: this.state });
  }

  private addMessage(chat: Chat, m: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const message = this.d.store.addMessage(chat, m);
    this.d.emit({ type: 'chat:message', chatId: chat.id, message });
    return message;
  }

  private touchMessage(chat: Chat, message: ChatMessage): void {
    this.d.store.touch(chat);
    this.d.emit({ type: 'chat:message', chatId: chat.id, message });
  }

  private retitle(chat: Chat, text: string): void {
    chat.title = text.replace(/\s+/g, ' ').slice(0, 48) || 'New chat';
    this.d.store.touch(chat);
    this.d.emit({ type: 'chat:title', chatId: chat.id, title: chat.title });
    this.d.emit({ type: 'chat:list', chats: this.d.store.listChats() });
  }

  private async checkpoint(): Promise<void> {
    if (this.abort?.signal.aborted) throw new StoppedError(this.stopReason);
    if (this.pauseGate) {
      await this.pauseGate;
      if (this.abort?.signal.aborted) throw new StoppedError(this.stopReason);
    }
  }

  private speak(text: string): void {
    if (!text || !this.d.settings().voice.speakReplies) return;
    void this.d.backend()?.call('voice.speak', { text }).catch(() => undefined);
  }

  private releaseAllConfirms(approved: boolean): void {
    for (const id of [...this.confirms.keys()]) this.confirm(id, approved);
  }

  // ------------------------------------------------------------------ main run
  private async run(chat: Chat, goal: string, mode: 'agent' | 'chat'): Promise<void> {
    const backend = this.d.backend();
    let hudShown = false;
    try {
      const bridge = this.d.getBridge();
      if (mode === 'chat') {
        await this.runChat(chat, goal, bridge);
        return;
      }
      if (!backend) throw new Error('The OS-automation backend is not running. Check the status bar for details.');
      const info = this.d.backendInfo();
      if (info && !info.input.driver) {
        throw new Error(`No mouse/keyboard driver is available: ${info.input.error ?? 'unknown reason'}`);
      }
      await backend.call('kill.reset').catch(() => undefined);
      await backend.call('voice.agent_busy', { busy: true }).catch(() => undefined);
      this.target = this.d.settings().desktopMode;
      let sandboxApps: string[] | undefined;
      if (this.target === 'sandbox') sandboxApps = await this.prepareSandbox(backend);
      await bridge.startConversation();
      if (this.target === 'real') {
        this.d.enterHud(); // your own screen: hide this window, show the pill
        hudShown = true;
      }
      await this.agentLoop(chat, goal, bridge, backend, info, sandboxApps);
    } catch (err) {
      this.reportFailure(chat, err);
    } finally {
      if (backend) {
        await backend.call('voice.agent_busy', { busy: false }).catch(() => undefined);
        if (this.expectingOwnKill) await backend.call('kill.reset').catch(() => undefined);
      }
      this.expectingOwnKill = false;
      this.releaseAllConfirms(false);
      this.resume();
      if (hudShown) this.d.exitHud();
      if (this.target === 'sandbox' && backend) this.scheduleStreamStop(backend);
      this.abort = null;
      this.setState({ status: 'idle', step: 0, label: undefined });
      this.d.emit({ type: 'chat:list', chats: this.d.store.listChats() });
    }
  }

  /** Start the private virtual desktop + live stream; returns the apps installed there. */
  private async prepareSandbox(backend: BackendClient): Promise<string[]> {
    if (this.streamStopTimer) clearTimeout(this.streamStopTimer);
    this.streamStopTimer = null;
    const cfg = this.d.settings();
    this.setState({ label: 'Starting the sandbox desktop…' });
    let st: SandboxState;
    try {
      st = await backend.call<SandboxState>('sandbox.start', { width: cfg.sandboxWidth, height: cfg.sandboxHeight }, 45_000);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`The sandbox desktop could not start: ${why}\nInstall xvfb (sudo apt install xvfb xdotool), or switch to “My desktop” under the prompt box.`);
    }
    this.d.emit({ type: 'sandbox', state: st });
    await backend.call('stream.start', { target: 'sandbox', fps: 15, width: 960, quality: 55 }).catch((e) => this.d.log(`stream.start: ${e}`));
    try {
      const r = await backend.call<ExecResult>('action.execute', {
        target: 'sandbox',
        action: { action: 'bash', command: 'for a in firefox chromium chromium-browser google-chrome xterm gnome-terminal xfce4-terminal mousepad gedit pluma libreoffice thunar pcmanfm nautilus eog evince; do command -v $a >/dev/null 2>&1 && echo $a; done' },
      }, 15_000);
      return (r.output?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private scheduleStreamStop(backend: BackendClient): void {
    if (this.streamStopTimer) clearTimeout(this.streamStopTimer);
    this.streamStopTimer = setTimeout(() => {
      this.streamStopTimer = null;
      void backend.call('stream.stop').catch(() => undefined);
    }, 4000);
  }

  private reportFailure(chat: Chat, err: unknown): void {
    if (err instanceof StoppedError) {
      const text = err.reason === 'kill'
        ? '🛑 Emergency stop (Esc Esc). All mouse, keyboard and shell activity was halted. Press “Re-arm” when you are ready.'
        : 'Stopped. You are back in control.';
      this.addMessage(chat, { role: 'system', kind: 'text', content: text });
      return;
    }
    let text = err instanceof Error ? err.message : String(err);
    if (err instanceof BridgeError) {
      if (err.kind === 'not_signed_in') this.d.onAuthProblem();
      if (err.kind === 'aborted') return;
    }
    this.d.log(`task failed: ${text}`);
    text = `⚠️ ${text}`;
    this.addMessage(chat, { role: 'system', kind: 'text', content: text });
    this.speak('Something went wrong. ' + text.replace('⚠️', ''));
  }

  // ---------------------------------------------------------------- chat mode
  private async runChat(chat: Chat, text: string, bridge: ClaudeBridge): Promise<void> {
    this.setState({ label: 'Waiting for Claude…' });
    await bridge.startConversation(chat.claudeUrl);
    const res = await bridge.send({ text }, this.abort!.signal);
    if (res.conversationUrl) chat.claudeUrl = res.conversationUrl;
    this.addMessage(chat, { role: 'assistant', kind: 'text', content: res.text.trim() });
    this.speak(res.text);
  }

  // --------------------------------------------------------------- agent mode
  /** Watch the screen (it settles first), read it as text, and decide whether an image is needed. */
  private async observe(backend: BackendClient): Promise<Observation> {
    const mask = this.target === 'real' ? this.d.hudMask() : null; // keep the agent's own HUD out of the picture
    const wantLook = this.wantLook;
    this.wantLook = false;
    const r = await backend.call<{
      text: string; image_b64: string | null; image_kind: ImageKind; thumb_b64: string; width: number; height: number;
      changed: boolean | null; meta: PerceptionMeta;
    }>('perception.observe', {
      target: this.target, vision: this.d.settings().visionMode, force_image: wantLook, settle: true, settle_timeout: 4, mask: mask ?? undefined,
    }, 90_000);
    this.d.emit({ type: 'perception', text: r.text, imageKind: r.image_kind, meta: r.meta, ts: Date.now() });
    return {
      text: r.text, image: r.image_b64 ? Buffer.from(r.image_b64, 'base64') : undefined, imageKind: r.image_kind,
      thumb: Buffer.from(r.thumb_b64, 'base64'), width: r.width, height: r.height, changed: r.changed, meta: r.meta,
    };
  }

  private async askClaude(bridge: ClaudeBridge, chat: Chat, prompt: string, image: Buffer | undefined): Promise<AgentReply> {
    let text = prompt;
    let img: Buffer | undefined = image;
    for (let attempt = 0; ; attempt++) {
      const res = await bridge.send({ text, image: img }, this.abort!.signal);
      if (res.conversationUrl) chat.claudeUrl = res.conversationUrl;
      try {
        return parseAgentReply(res.text, res.codeBlocks);
      } catch (e) {
        if (!(e instanceof ParseError) || attempt >= MAX_PARSE_RETRIES) {
          const preview = res.text.replace(/\s+/g, ' ').slice(0, 220);
          throw new Error(`Claude's reply was not valid action JSON (${e instanceof Error ? e.message : e}). It said: “${preview}”`);
        }
        this.d.log(`unparseable reply (attempt ${attempt + 1}): ${e instanceof Error ? e.message : e}`);
        text = buildFormatReminder(e instanceof Error ? e.message : 'invalid JSON');
        img = undefined;
      }
    }
  }

  private async agentLoop(chat: Chat, goal: string, bridge: ClaudeBridge, backend: BackendClient, info?: BackendInfo, sandboxApps?: string[]): Promise<void> {
    const settings = this.d.settings();
    this.setState({ label: 'Reading the screen…' });
    let obs = await this.observe(backend);
    const env: PromptEnv = {
      session: info?.session.kind ?? 'unknown',
      desktop: info?.session.desktop ?? '',
      screen: { width: obs.width, height: obs.height },
      vision: settings.visionMode,
      hasAtspi: this.target === 'real' ? !!info?.atspi.available : !!obs.meta.atspi,
      sandbox: this.target === 'sandbox' ? { apps: sandboxApps ?? [] } : undefined,
      tools: Object.entries(info?.session.tools ?? {}).filter(([, v]) => v).map(([k]) => k),
    };
    let prompt = buildInitialPrompt(goal, env, obs.text);

    for (let step = 1; step <= settings.maxSteps; step++) {
      this.setState({ step, label: 'Claude is thinking…' });
      await this.checkpoint();
      const reply = await this.askClaude(bridge, chat, prompt, obs.image);
      await this.checkpoint();

      const rec: StepRecord = {
        step,
        thought: reply.thought,
        screenshot: thumbnailDataUrl(obs.thumb),
        shotWidth: obs.width,
        shotHeight: obs.height,
        changed: obs.changed,
        vision: { kind: obs.imageKind, text: true, meta: obs.meta },
        actions: reply.actions.map((a) => ({ id: randomUUID(), action: a, status: 'pending' as const })),
      };
      const msg = this.addMessage(chat, { role: 'assistant', kind: 'step', content: reply.message, step: rec });
      if (reply.message && !reply.done) this.speak(reply.message);

      const results: ActionRecord[] = [];
      let skipped = 0;
      for (let i = 0; i < rec.actions.length; i++) {
        if (this.interjections.length) {
          skipped = rec.actions.length - i;
          for (let j = i; j < rec.actions.length; j++) rec.actions[j].status = 'skipped';
          this.touchMessage(chat, msg);
          break;
        }
        await this.checkpoint();
        const a = rec.actions[i];
        this.setState({ label: this.labelFor(a.action) });
        await this.execute(backend, chat, a, () => this.touchMessage(chat, msg));
        results.push(a);
        this.touchMessage(chat, msg);
        if (a.status === 'killed') throw new StoppedError(this.stopReason === 'user' ? 'user' : 'kill');
        if (a.status === 'denied') {
          for (let j = i + 1; j < rec.actions.length; j++) rec.actions[j].status = 'skipped';
          this.touchMessage(chat, msg);
          break;
        }
        await sleep(settings.stepDelayMs);
      }

      if (reply.done && !this.interjections.length) {
        this.addMessage(chat, { role: 'assistant', kind: 'text', content: reply.message || 'Done.' });
        this.speak(reply.message || 'Done.');
        return;
      }
      if (step === settings.maxSteps) {
        this.addMessage(chat, { role: 'system', kind: 'text', content: `Stopped after ${settings.maxSteps} steps (limit in Settings). Say “continue” to keep going.` });
        return;
      }

      // Verify: give the effect a moment to start, then let the perception engine wait for the screen to settle.
      if (results.some((r) => r.action.action === 'look' || r.action.action === 'screenshot')) this.wantLook = true;
      this.setState({ label: 'Watching the result…' });
      await sleep(Math.max(350, settings.stepDelayMs));
      await this.checkpoint();
      obs = await this.observe(backend);
      const interjection = this.interjections.splice(0).join('\n') || undefined;
      prompt = buildFollowUp({
        results, changed: obs.changed, screen: { width: obs.width, height: obs.height }, interjection,
        skippedBecauseInterrupted: skipped, screenText: obs.text, imageKind: obs.imageKind,
      });
    }
  }

  private labelFor(a: AgentAction): string {
    switch (a.action) {
      case 'bash': return `Running: ${(a.command ?? '').slice(0, 48)}`;
      case 'type': return 'Typing…';
      case 'hotkey': return `Pressing ${(a.keys ?? []).join('+')}`;
      case 'scroll': return `Scrolling ${a.direction}`;
      case 'wait': return 'Waiting…';
      default: return a.target ? `${a.action.replace('_', ' ')}: ${a.target}` : a.action.replace('_', ' ');
    }
  }

  // ------------------------------------------------------------ execute step
  private async execute(backend: BackendClient, chat: Chat, rec: ActionRecord, touch: () => void): Promise<void> {
    const timeout = ((rec.action.timeout ?? 60) + 20) * 1000;
    rec.status = 'running';
    touch();
    let res: ExecResult;
    try {
      res = await backend.call<ExecResult>('action.execute', { target: this.target, action: rec.action }, Math.max(30_000, timeout));
      if (res.needs_confirmation) {
        rec.status = 'awaiting_approval';
        rec.risk = res.risk;
        touch();
        const ok = await this.askApproval(chat.id, rec);
        if (!ok) {
          rec.status = 'denied';
          rec.message = this.abort?.signal.aborted ? 'Cancelled' : 'Denied by user';
          return;
        }
        rec.status = 'running';
        touch();
        res = await backend.call<ExecResult>('action.execute', { target: this.target, action: rec.action, approved: true }, Math.max(30_000, timeout));
      }
    } catch (e) {
      rec.status = this.abort?.signal.aborted ? 'killed' : 'error';
      rec.message = e instanceof Error ? e.message : String(e);
      return;
    }
    rec.status = res.killed ? 'killed' : res.ok ? 'ok' : 'error';
    rec.message = res.message ?? res.error;
    rec.screen = res.screen;
    rec.durationMs = res.duration_ms;
    if (rec.action.action === 'bash' && res.output) {
      rec.output = { stdout: res.output.stdout, stderr: res.output.stderr, exit_code: res.output.exit_code, timed_out: res.output.timed_out };
    }
  }

  private async askApproval(chatId: string, rec: ActionRecord): Promise<boolean> {
    const id = randomUUID();
    const risk = rec.risk ?? { reason: 'Sensitive action', category: 'flagged' };
    const answer = new Promise<boolean>((resolve) => this.confirms.set(id, { resolve, chatId }));
    this.setState({ status: 'waiting_confirmation', label: 'Waiting for your approval' });
    this.d.setHudExpanded(true);
    this.d.emit({ type: 'confirm', request: { id, chatId, reason: risk.reason, category: risk.category, action: rec.action } });

    const voice = this.d.settings().voice;
    if (voice.speakReplies || voice.handsFree) {
      const b = this.d.backend();
      void b?.call('voice.speak', { text: `I need your approval. ${risk.reason}. Say approve or deny.` }).catch(() => undefined);
      void b?.call('voice.listen_once').catch(() => undefined);
    }
    const ok = await answer;
    if (this.state.status === 'waiting_confirmation') this.setState({ status: 'running', label: undefined });
    return ok;
  }
}
