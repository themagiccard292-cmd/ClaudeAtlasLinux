// Types shared by the Electron main process and the React renderer.

// ------------------------------------------------------------------ backend
export type SessionKind = 'x11' | 'wayland' | 'headless';

export interface BackendInfo {
  version: string;
  frozen: boolean;
  session: {
    kind: SessionKind;
    desktop: string;
    xwayland: boolean;
    detected_from: string;
    tools: Record<string, boolean>;
  };
  input: { driver: string | null; error: string | null };
  atspi: { available: boolean; python?: string | null; reason?: string };
  hotkeys: { source: string | null; error: string | null; warning: string | null; kill_combo?: string; ptt_combo?: string };
  voice: Record<string, unknown>;
  kill: { active: boolean; source: string | null };
  primary_monitor: { name: string; x: number; y: number; width: number; height: number } | null;
}

export type BackendStatus = 'starting' | 'ready' | 'error' | 'stopped';

export interface BackendState {
  status: BackendStatus;
  info?: BackendInfo;
  error?: string;
}

// --------------------------------------------------------------------- auth
export type Plan = 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown';

export interface AuthState {
  status: 'signed_out' | 'checking' | 'signed_in';
  plan?: Plan;
  email?: string;
  orgName?: string;
  /** Cookie present but the account endpoint could not be reached. */
  unverified?: boolean;
  error?: string;
}

// ----------------------------------------------------------------- settings
export type BridgeMode = 'web' | 'cli';

export interface VoiceSettings {
  inputDevice: number | string | null;
  outputDevice: number | string | null;
  whisperModel: string;
  language: string;
  ttsEngine: 'edge' | 'piper' | 'espeak' | 'off';
  ttsVoice: string;
  speakReplies: boolean;
  handsFree: boolean;
  wakeWord: string;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  bridgeMode: BridgeMode;
  cliPath: string;
  maxSteps: number;
  stepDelayMs: number;
  hudType: 'dock' | 'toolbar';
  voice: VoiceSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  bridgeMode: 'web',
  cliPath: 'claude',
  maxSteps: 40,
  stepDelayMs: 500,
  hudType: 'dock',
  voice: {
    inputDevice: null,
    outputDevice: null,
    whisperModel: 'base.en',
    language: 'en',
    ttsEngine: 'edge',
    ttsVoice: 'en-US-AriaNeural',
    speakReplies: false,
    handsFree: false,
    wakeWord: 'hey claude',
  },
};

// -------------------------------------------------------------------- agent
export type ActionType =
  | 'click' | 'double_click' | 'right_click' | 'middle_click' | 'move' | 'drag' | 'scroll'
  | 'type' | 'hotkey' | 'bash' | 'wait' | 'screenshot'
  | 'atspi_windows' | 'atspi_tree' | 'atspi_find' | 'atspi_click';

/** A validated, sanitised action (never contains approval fields). */
export interface AgentAction {
  action: ActionType;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  button?: 'left' | 'right' | 'middle';
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  text?: string;
  keys?: string[];
  command?: string;
  timeout?: number;
  cwd?: string;
  seconds?: number;
  name?: string;
  role?: string;
  scope?: string;
  index?: number;
  target?: string;
  requires_confirmation?: boolean;
  reason?: string;
}

export interface AgentReply {
  thought: string;
  actions: AgentAction[];
  done: boolean;
  message: string;
}

export type ActionStatus = 'pending' | 'awaiting_approval' | 'running' | 'ok' | 'error' | 'denied' | 'killed' | 'skipped';

export interface ActionRecord {
  id: string;
  action: AgentAction;
  status: ActionStatus;
  message?: string;
  output?: { stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean };
  risk?: { reason: string; category: string };
  /** Real screen coordinates the click landed on. */
  screen?: { x: number; y: number; to_x?: number; to_y?: number };
  durationMs?: number;
}

export interface StepRecord {
  step: number;
  thought: string;
  /** Thumbnail (data URL) of the screenshot Claude saw for this step. */
  screenshot?: string;
  shotWidth?: number;
  shotHeight?: number;
  actions: ActionRecord[];
  changed?: boolean | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'step';
  content: string;
  createdAt: number;
  via?: 'text' | 'voice';
  step?: StepRecord;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  claudeUrl?: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface Workflow {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
}

export type AgentStatus = 'idle' | 'running' | 'paused' | 'waiting_confirmation' | 'stopping';

export interface AgentState {
  status: AgentStatus;
  chatId?: string;
  step: number;
  maxSteps: number;
  label?: string;
}

export interface ConfirmRequest {
  id: string;
  chatId: string;
  reason: string;
  category: string;
  action: AgentAction;
}

export type VoiceUiState = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'speaking';

export interface AudioDevice {
  index: number;
  name: string;
  hostapi: string;
  sample_rate: number;
}

export interface AudioDevices {
  input: AudioDevice[];
  output: AudioDevice[];
  default_input: number | null;
  default_output: number | null;
  error?: string;
}

export interface BridgeDiagnosis {
  ok: boolean;
  url: string;
  signedIn: boolean;
  checks: Record<string, number | boolean>;
  notes: string[];
}

export interface AppInfo {
  version: string;
  platform: string;
  packaged: boolean;
  userData: string;
  wmType: string;
}
