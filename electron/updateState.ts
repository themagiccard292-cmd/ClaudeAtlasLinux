import type { UpdateState } from '../shared/types';

/** Release notes arrive as HTML, markdown or a per-version array; show a short plain-text version. */
export function notesToText(notes: unknown): string | undefined {
  let raw = '';
  if (typeof notes === 'string') raw = notes;
  else if (Array.isArray(notes)) raw = notes.map((n) => (typeof n === 'string' ? n : String((n as { note?: string })?.note ?? ''))).join('\n');
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return undefined;
  return text.length > 700 ? `${text.slice(0, 700).trimEnd()}…` : text;
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes?: unknown }
  | { type: 'none' }
  | { type: 'progress'; percent: number; bytesPerSecond: number }
  | { type: 'downloaded'; version: string; notes?: unknown }
  | { type: 'error'; message: string };

/** Pure state machine for the update UI (unit-tested; no Electron imports). */
export function reduceUpdate(prev: UpdateState, ev: UpdateEvent, now = Date.now()): UpdateState {
  switch (ev.type) {
    case 'checking':
      // never knock a finished download back to "checking"
      return prev.status === 'downloaded' || prev.status === 'downloading' ? prev : { ...prev, status: 'checking', error: undefined };
    case 'available':
      return { ...prev, status: 'available', version: ev.version, notes: notesToText(ev.notes), progress: undefined, error: undefined, checkedAt: now };
    case 'none':
      return prev.status === 'downloaded' ? prev : { ...prev, status: 'none', version: undefined, notes: undefined, progress: undefined, error: undefined, checkedAt: now };
    case 'progress':
      return { ...prev, status: 'downloading', progress: Math.max(0, Math.min(100, Math.round(ev.percent))), bytesPerSecond: ev.bytesPerSecond };
    case 'downloaded':
      return { ...prev, status: 'downloaded', version: ev.version, notes: notesToText(ev.notes) ?? prev.notes, progress: 100, error: undefined, checkedAt: now };
    case 'error':
      // an error while checking must not hide an update that is already downloaded
      return prev.status === 'downloaded' ? { ...prev, error: ev.message } : { ...prev, status: 'error', error: ev.message, progress: undefined, checkedAt: now };
  }
}

/** True when `candidate` is a newer semantic version than `current` (ignores build metadata). */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('+')[0].split('-');
    return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre ?? '' };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a.n[i] ?? 0) !== (b.n[i] ?? 0)) return (a.n[i] ?? 0) > (b.n[i] ?? 0);
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true; // 1.2.0 > 1.2.0-beta
  if (!b.pre) return false;
  return a.pre > b.pre;
}
