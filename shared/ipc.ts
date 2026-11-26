import type {
  AgentState, AppInfo, AudioDevices, AuthState, BackendState, BridgeDiagnosis, Chat, ChatMessage, ChatSummary,
  ConfirmRequest, LiveFx, SandboxState, Settings, UpdateState, VoiceUiState, Workflow,
} from './types';

/** Request/response channels (renderer → main). */
export interface InvokeMap {
  'app:info': { args: []; result: AppInfo };
  'backend:state': { args: []; result: BackendState };
  'auth:state': { args: []; result: AuthState };
  'auth:beginLogin': { args: []; result: void };
  'auth:cancelLogin': { args: []; result: void };
  'auth:logout': { args: []; result: void };
  'bridge:diagnose': { args: []; result: BridgeDiagnosis };
  'settings:get': { args: []; result: Settings };
  'settings:set': { args: [Partial<Settings>]; result: Settings };
  'chat:list': { args: []; result: ChatSummary[] };
  'chat:get': { args: [string]; result: Chat | null };
  'chat:create': { args: []; result: Chat };
  'chat:delete': { args: [string]; result: void };
  'workflow:list': { args: []; result: Workflow[] };
  'workflow:save': { args: [{ name: string; prompt: string }]; result: Workflow[] };
  'workflow:delete': { args: [string]; result: Workflow[] };
  'agent:state': { args: []; result: AgentState };
  'agent:start': { args: [{ chatId: string; text: string; mode: 'agent' | 'chat'; via?: 'text' | 'voice' }]; result: void };
  'agent:stop': { args: []; result: void };
  'agent:takeover': { args: []; result: void };
  'agent:pause': { args: []; result: void };
  'agent:resume': { args: []; result: void };
  'agent:confirm': { args: [{ id: string; approved: boolean }]; result: void };
  'update:state': { args: []; result: UpdateState };
  'update:check': { args: []; result: UpdateState };
  'update:download': { args: []; result: UpdateState };
  'update:install': { args: []; result: void };
  'sandbox:state': { args: []; result: SandboxState | null };
  'sandbox:start': { args: []; result: SandboxState };
  'sandbox:reset': { args: []; result: SandboxState };
  'kill:trigger': { args: []; result: void };
  'kill:reset': { args: []; result: void };
  'voice:devices': { args: []; result: AudioDevices };
  'voice:ptt': { args: [boolean]; result: void };
  'voice:handsFree': { args: [boolean]; result: void };
  'voice:speak': { args: [string]; result: void };
  'voice:stopSpeaking': { args: []; result: void };
}

export type InvokeChannel = keyof InvokeMap;

/** One-way messages (renderer → main). */
export interface SendMap {
  'auth:loginBounds': [{ x: number; y: number; width: number; height: number } | null];
}
export type SendChannel = keyof SendMap;

/** Push events (main → renderer), delivered on the single `atlas:event` channel. */
export type AtlasEvent =
  | { type: 'backend'; state: BackendState }
  | { type: 'auth'; state: AuthState }
  | { type: 'agent'; state: AgentState }
  | { type: 'chat:list'; chats: ChatSummary[] }
  | { type: 'chat:message'; chatId: string; message: ChatMessage }
  | { type: 'chat:title'; chatId: string; title: string }
  | { type: 'confirm'; request: ConfirmRequest | null }
  | { type: 'voice:level'; level: number; source: 'mic' | 'tts' }
  | { type: 'voice:state'; state: VoiceUiState; mode?: string }
  | { type: 'voice:transcript'; text: string; source: string }
  | { type: 'voice:error'; message: string }
  | { type: 'voice:status'; message: string }
  | { type: 'kill'; active: boolean; source?: string }
  | { type: 'hud'; active: boolean }
  | { type: 'live:frame'; target: 'real' | 'sandbox'; seq: number; w: number; h: number; pointer: [number, number] | null; jpeg: string | null; ended?: boolean }
  | { type: 'live:fx'; fx: LiveFx }
  | { type: 'sandbox'; state: SandboxState }
  | { type: 'update'; state: UpdateState }
  | { type: 'settings'; settings: Settings }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string };

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:info', 'backend:state', 'auth:state', 'auth:beginLogin', 'auth:cancelLogin', 'auth:logout',
  'bridge:diagnose', 'settings:get', 'settings:set', 'chat:list', 'chat:get', 'chat:create', 'chat:delete',
  'workflow:list', 'workflow:save', 'workflow:delete', 'agent:state', 'agent:start', 'agent:stop',
  'agent:takeover', 'agent:pause', 'agent:resume', 'agent:confirm', 'update:state', 'update:check', 'update:download', 'update:install', 'sandbox:state', 'sandbox:start',
  'sandbox:reset', 'kill:trigger', 'kill:reset',
  'voice:devices', 'voice:ptt', 'voice:handsFree', 'voice:speak', 'voice:stopSpeaking',
];

export const SEND_CHANNELS: readonly SendChannel[] = ['auth:loginBounds'];

export interface AtlasApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeMap[C]['args']): Promise<InvokeMap[C]['result']>;
  send<C extends SendChannel>(channel: C, ...args: SendMap[C]): void;
  onEvent(cb: (event: AtlasEvent) => void): () => void;
}
