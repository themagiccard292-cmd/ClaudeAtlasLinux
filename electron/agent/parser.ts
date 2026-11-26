import type { ActionType, AgentAction, AgentReply } from '../../shared/types';

export class ParseError extends Error {}

export const ACTION_TYPES: readonly ActionType[] = [
  'click', 'double_click', 'right_click', 'middle_click', 'move', 'drag', 'scroll', 'type', 'hotkey', 'bash',
  'wait', 'screenshot', 'atspi_windows', 'atspi_tree', 'atspi_find', 'atspi_click',
];

const ALIASES: Record<string, ActionType> = {
  left_click: 'click', mouse_move: 'move', press: 'hotkey', key: 'hotkey', keypress: 'hotkey', shell: 'bash',
  run: 'bash', sleep: 'wait', scroll_down: 'scroll', scroll_up: 'scroll',
};

const MAX_ACTIONS = 6;

// ------------------------------------------------------------------ extraction
/** Every top-level `{...}` in `text`, honouring string literals and escapes. */
export function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function candidates(text: string, codeBlocks: string[]): string[] {
  const out: string[] = [];
  for (const block of [...codeBlocks].reverse()) out.push(...balancedObjects(block).reverse());
  const fenced = [...text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fenced.reverse()) out.push(...balancedObjects(block).reverse());
  out.push(...balancedObjects(text).reverse());
  return [...new Set(out)];
}

function parseLenient(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const repaired = raw
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

// ---------------------------------------------------------------- normalisation
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown, max = 8000): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function point(raw: Record<string, unknown>, xk: string, yk: string, alts: string[]): [number, number] | undefined {
  const x = num(raw[xk]);
  const y = num(raw[yk]);
  if (x !== undefined && y !== undefined) return [x, y];
  for (const k of alts) {
    const v = raw[k];
    if (Array.isArray(v) && v.length === 2) {
      const a = num(v[0]);
      const b = num(v[1]);
      if (a !== undefined && b !== undefined) return [a, b];
    }
    if (isRecord(v)) {
      const a = num(v.x);
      const b = num(v.y);
      if (a !== undefined && b !== undefined) return [a, b];
    }
  }
  return undefined;
}

/**
 * Whitelist-copy a model-supplied action. Anything not explicitly known (notably
 * `approved`, which would otherwise bypass the confirmation gate) is dropped.
 */
export function sanitizeAction(raw: unknown): AgentAction {
  if (!isRecord(raw)) throw new ParseError('Each action must be a JSON object');
  let name = String(raw.action ?? raw.type ?? '').trim().toLowerCase();
  name = ALIASES[name] ?? name;
  if (!(ACTION_TYPES as readonly string[]).includes(name)) {
    throw new ParseError(`Unknown action "${name}". Valid actions: ${ACTION_TYPES.join(', ')}`);
  }
  const kind = name as ActionType;
  const out: AgentAction = { action: kind };

  const target = str(raw.target, 200);
  if (target) out.target = target;
  const reason = str(raw.reason, 300);
  if (reason) out.reason = reason;
  if (raw.requires_confirmation === true || raw.requires_confirmation === 'true') out.requires_confirmation = true;

  switch (kind) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'move': {
      const p = point(raw, 'x', 'y', ['coordinate', 'coordinates', 'position', 'point', 'at']);
      if (!p) throw new ParseError(`"${kind}" needs numeric x and y`);
      [out.x, out.y] = p;
      if (kind === 'click') {
        const b = String(raw.button ?? 'left').toLowerCase();
        if (b !== 'left' && b !== 'right' && b !== 'middle') throw new ParseError(`Invalid button "${b}"`);
        out.button = b;
        if (raw.double === true) out.action = 'double_click';
      }
      break;
    }
    case 'drag': {
      const a = point(raw, 'x', 'y', ['coordinate', 'start', 'from']);
      const b = point(raw, 'to_x', 'to_y', ['to', 'end', 'end_coordinate', 'target_coordinate']);
      if (!a || !b) throw new ParseError('"drag" needs x, y, to_x, to_y');
      [out.x, out.y] = a;
      [out.to_x, out.to_y] = b;
      break;
    }
    case 'scroll': {
      const fallback = name === 'scroll_up' || String(raw.action) === 'scroll_up' ? 'up' : 'down';
      const d = String(raw.direction ?? fallback).toLowerCase();
      if (!['up', 'down', 'left', 'right'].includes(d)) throw new ParseError(`Invalid scroll direction "${d}"`);
      out.direction = d as AgentAction['direction'];
      out.amount = Math.max(1, Math.min(Math.round(num(raw.amount) ?? 3), 50));
      const p = point(raw, 'x', 'y', ['coordinate', 'position']);
      if (p) [out.x, out.y] = p;
      break;
    }
    case 'type': {
      const t = str(raw.text, 4000);
      if (!t) throw new ParseError('"type" needs non-empty "text"');
      out.text = t;
      break;
    }
    case 'hotkey': {
      const k = raw.keys ?? raw.key ?? raw.combo ?? raw.text;
      let keys: string[] | undefined;
      if (Array.isArray(k)) keys = k.map(String).filter(Boolean);
      else if (typeof k === 'string' && k.trim()) keys = k.trim() === '+' ? ['+'] : k.split('+').map((s) => s.trim()).filter(Boolean);
      if (!keys?.length) throw new ParseError('"hotkey" needs "keys", e.g. ["ctrl","c"]');
      out.keys = keys.slice(0, 5);
      break;
    }
    case 'bash': {
      const c = str(raw.command ?? raw.cmd, 8000);
      if (!c) throw new ParseError('"bash" needs "command"');
      out.command = c;
      const t = num(raw.timeout);
      if (t !== undefined) out.timeout = Math.max(1, Math.min(Math.round(t), 600));
      const cwd = str(raw.cwd, 500);
      if (cwd) out.cwd = cwd;
      break;
    }
    case 'wait':
      out.seconds = Math.max(0, Math.min(num(raw.seconds) ?? 1, 30));
      break;
    case 'atspi_find':
    case 'atspi_click': {
      const n = str(raw.name, 200);
      const r = str(raw.role, 80);
      if (!n && !r) throw new ParseError(`"${kind}" needs "name" and/or "role"`);
      if (n) out.name = n;
      if (r) out.role = r;
      out.index = Math.max(0, Math.round(num(raw.index) ?? 0));
      out.scope = str(raw.scope, 80) ?? 'all';
      break;
    }
    case 'atspi_tree':
      out.scope = str(raw.scope, 80) ?? 'active';
      break;
    default:
      break;
  }
  return out;
}

function toReply(obj: unknown): AgentReply | null {
  if (!isRecord(obj)) return null;
  const actionsRaw = Array.isArray(obj.actions) ? obj.actions : typeof obj.action === 'string' ? [obj] : null;
  const hasDone = 'done' in obj || 'message' in obj || 'final_answer' in obj;
  if (!actionsRaw && !hasDone) return null;

  const actions = (actionsRaw ?? []).slice(0, MAX_ACTIONS).map(sanitizeAction);
  const done = obj.done === true || obj.done === 'true' || (actions.length === 0 && hasDone && obj.done !== false);
  const message = str(obj.message ?? obj.final_answer ?? obj.answer ?? obj.say ?? obj.status, 4000) ?? '';
  const thought = str(obj.thought ?? obj.reasoning ?? obj.thinking, 2000) ?? '';
  return { thought, actions, done, message };
}

/** Parse Claude's reply text (+ rendered code blocks) into a validated AgentReply. */
export function parseAgentReply(text: string, codeBlocks: string[] = []): AgentReply {
  const errors: string[] = [];
  for (const raw of candidates(text, codeBlocks)) {
    let obj: unknown;
    try {
      obj = parseLenient(raw);
    } catch {
      continue;
    }
    try {
      const reply = toReply(obj);
      if (reply) return reply;
    } catch (e) {
      if (e instanceof ParseError) errors.push(e.message);
      else throw e;
    }
  }
  if (errors.length) throw new ParseError(errors[0]);
  throw new ParseError('No JSON object with "actions" or "done" found in the reply');
}
