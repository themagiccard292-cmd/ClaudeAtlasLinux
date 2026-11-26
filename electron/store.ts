import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Chat, type ChatMessage, type ChatSummary, DEFAULT_SETTINGS, type Settings, type Workflow } from '../shared/types';

const ID_RE = /^[0-9a-f-]{36}$/;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: a crash mid-save can never leave a truncated JSON file behind. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

export function mergeSettings(stored: Partial<Settings> | undefined, patch: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ...patch,
    voice: { ...DEFAULT_SETTINGS.voice, ...stored?.voice, ...patch.voice },
  };
}

export class Store {
  private settingsFile: string;
  private workflowsFile: string;
  private chatsDir: string;
  private chats = new Map<string, Chat>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private _settings: Settings;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.chatsDir = join(dir, 'chats');
    mkdirSync(this.chatsDir, { recursive: true, mode: 0o700 });
    this.settingsFile = join(dir, 'settings.json');
    this.workflowsFile = join(dir, 'workflows.json');
    this._settings = mergeSettings(readJson<Partial<Settings>>(this.settingsFile, {}));
    for (const f of readdirSync(this.chatsDir)) {
      if (!f.endsWith('.json')) continue;
      const chat = readJson<Chat | null>(join(this.chatsDir, f), null);
      if (chat && ID_RE.test(chat.id)) this.chats.set(chat.id, chat);
    }
  }

  // -------------------------------------------------------------- settings
  get settings(): Settings {
    return this._settings;
  }

  setSettings(patch: Partial<Settings>): Settings {
    this._settings = mergeSettings(this._settings, patch);
    writeJson(this.settingsFile, this._settings);
    return this._settings;
  }

  // ----------------------------------------------------------------- chats
  listChats(): ChatSummary[] {
    return [...this.chats.values()]
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getChat(id: string): Chat | null {
    return ID_RE.test(id) ? this.chats.get(id) ?? null : null;
  }

  createChat(): Chat {
    const now = Date.now();
    const chat: Chat = { id: randomUUID(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
    this.chats.set(chat.id, chat);
    this.touch(chat);
    return chat;
  }

  deleteChat(id: string): void {
    if (!ID_RE.test(id)) return;
    this.chats.delete(id);
    this.dirty.delete(id);
    rmSync(join(this.chatsDir, `${id}.json`), { force: true });
  }

  addMessage(chat: Chat, m: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const message: ChatMessage = { ...m, id: randomUUID(), createdAt: Date.now() };
    chat.messages.push(message);
    this.touch(chat);
    return message;
  }

  /** Mark a chat changed; writes are debounced because step cards update many times per second. */
  touch(chat: Chat): void {
    chat.updatedAt = Date.now();
    this.dirty.add(chat.id);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 700);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      const chat = this.chats.get(id);
      if (chat) writeJson(join(this.chatsDir, `${id}.json`), chat);
    }
    this.dirty.clear();
  }

  // ------------------------------------------------------------- workflows
  workflows(): Workflow[] {
    return existsSync(this.workflowsFile) ? readJson<Workflow[]>(this.workflowsFile, []) : [];
  }

  saveWorkflow(name: string, prompt: string): Workflow[] {
    const list = this.workflows();
    list.unshift({ id: randomUUID(), name: name.trim().slice(0, 80) || 'Untitled workflow', prompt: prompt.trim(), createdAt: Date.now() });
    writeJson(this.workflowsFile, list.slice(0, 200));
    return list;
  }

  deleteWorkflow(id: string): Workflow[] {
    const list = this.workflows().filter((w) => w.id !== id);
    writeJson(this.workflowsFile, list);
    return list;
  }
}
