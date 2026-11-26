import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** JSON-RPC-ish WebSocket client for the Python sidecar. Emits `event` (name, data) and `close`. */
export class BackendClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(private readonly url: string) {
    super();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out connecting to the OS-automation backend'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('close', () => {
        this.ws = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Backend connection closed'));
          this.pending.delete(id);
        }
        this.emit('close');
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: string; message: string }; event?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event) {
      this.emit('event', msg.event, msg.data ?? {});
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.connected) return reject(new Error('Backend is not connected'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Backend call "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
