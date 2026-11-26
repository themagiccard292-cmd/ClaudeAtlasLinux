export interface BridgeMessage {
  text: string;
  /** JPEG bytes (≤1280×720). */
  image?: Buffer;
}

export interface BridgeResult {
  text: string;
  /** innerText of every <pre> block of the reply (raw JSON survives markdown rendering there). */
  codeBlocks: string[];
  /** Permalink of the claude.ai conversation, when known. */
  conversationUrl?: string;
}

export type BridgeErrorKind = 'not_signed_in' | 'rate_limit' | 'timeout' | 'dom' | 'aborted' | 'cli' | 'network';

export class BridgeError extends Error {
  constructor(message: string, public kind: BridgeErrorKind) {
    super(message);
  }
}

export interface ClaudeBridge {
  readonly kind: 'web' | 'cli';
  /** Begin a fresh conversation (or resume `resumeUrl` when supported). */
  startConversation(resumeUrl?: string): Promise<void>;
  send(msg: BridgeMessage, signal: AbortSignal): Promise<BridgeResult>;
  dispose(): void;
}
