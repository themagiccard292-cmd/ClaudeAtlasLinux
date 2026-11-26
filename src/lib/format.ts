import type { ActionRecord, AgentAction } from '../../shared/types';

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function actionTitle(a: AgentAction): string {
  switch (a.action) {
    case 'click': case 'double_click': case 'right_click': case 'middle_click': case 'move':
      return `${a.action.replace('_', ' ')} (${a.x}, ${a.y})`;
    case 'drag': return `drag (${a.x}, ${a.y}) → (${a.to_x}, ${a.to_y})`;
    case 'scroll': return `scroll ${a.direction} ×${a.amount}`;
    case 'type': return `type “${truncate(a.text ?? '', 48)}”`;
    case 'hotkey': return (a.keys ?? []).join(' + ');
    case 'bash': return truncate(a.command ?? '', 64);
    case 'wait': return `wait ${a.seconds}s`;
    case 'atspi_click': case 'atspi_find': return `${a.action.replace('_', ' ')} ${a.role ?? ''} “${a.name ?? ''}”`;
    default: return a.action.replace('_', ' ');
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function statusTone(s: ActionRecord['status']): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (s) {
    case 'ok': return 'ok';
    case 'error': case 'killed': case 'denied': return 'danger';
    case 'awaiting_approval': return 'warn';
    default: return 'muted';
  }
}

export const PLAN_LABEL: Record<string, string> = {
  free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', unknown: 'Account',
};
