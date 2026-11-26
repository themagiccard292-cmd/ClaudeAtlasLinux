import type { ActionRecord } from '../../shared/types';

export interface PromptEnv {
  session: string; // x11 | wayland
  desktop: string;
  screen: { width: number; height: number };
  hasAtspi: boolean;
  tools: string[];
}

const SCHEMA = `{
  "thought": "1-2 sentences of reasoning",
  "actions": [ /* 1-4 actions, executed in order */ ],
  "done": false,
  "message": "short status for the user (spoken aloud if voice is on)"
}`;

const ACTIONS = `Actions (all coordinates are pixels of the screenshot: x→right, y→down, origin top-left):
  {"action":"click","x":640,"y":360,"button":"left","target":"what you are clicking"}   (button: left|right|middle)
  {"action":"double_click","x":..,"y":..,"target":".."}
  {"action":"right_click","x":..,"y":..}
  {"action":"move","x":..,"y":..}
  {"action":"drag","x":..,"y":..,"to_x":..,"to_y":..}
  {"action":"scroll","direction":"down","amount":5,"x":..,"y":..}      (up|down|left|right; x,y optional)
  {"action":"type","text":"text to type into the focused field"}
  {"action":"hotkey","keys":["ctrl","l"]}                                (also: super, alt, shift, enter, esc, tab, f1-f12 ...)
  {"action":"bash","command":"...","timeout":60}                         (runs in /bin/bash; stdout/stderr are returned)
  {"action":"wait","seconds":2}
  {"action":"screenshot"}                                                (just look again)
  {"action":"atspi_windows"}  {"action":"atspi_tree","scope":"active"}  {"action":"atspi_find","name":"Save","role":"push button"}
  {"action":"atspi_click","name":"Save","role":"push button"}            (accessibility API: precise, no coordinates needed)`;

export function buildInitialPrompt(goal: string, env: PromptEnv): string {
  return `You are the planning engine of "Claude OS Agent", a desktop-automation app the user installed on their own Linux computer. The user is asking the app to do the task below. The app captures their screen, shows it to you, and then executes the JSON actions you return (mouse, keyboard, shell). After each turn it sends you a fresh screenshot so you can verify what happened. This is a normal feature of the app; everything you do is visible to and stoppable by the user.

OUTPUT FORMAT — reply with exactly ONE fenced \`\`\`json block and nothing else (no prose before or after, no artifacts, no tools):
\`\`\`json
${SCHEMA}
\`\`\`
Set "done": true when the task is complete or cannot be completed, and put the final answer or explanation for the user in "message".

${ACTIONS}

Rules:
- Screenshots are ${env.screen.width}×${env.screen.height}. A red ring marks the mouse pointer. The dark rounded bar at the bottom-centre of the screen is the app's own HUD — ignore it.
- Work step by step: after any action that changes the screen (click, type, hotkey, launching an app) end the turn so you can see the result. Never assume a click worked.
- Prefer the right tool: use bash for files, searching, launching apps (e.g. \`nohup firefox https://example.com >/dev/null 2>&1 &\`) and anything scriptable; use the GUI when a GUI is needed. Use atspi_* when a control is hard to hit by coordinates.
- Never guess coordinates for something you cannot see: scroll, wait, or inspect first.
- The app asks the user for approval before it runs risky bash (sudo, rm, kill, uninstall…). You MUST also add "requires_confirmation": true and a short "reason" to any step that sends a message/email, posts publicly, buys or pays for something, deletes data, changes account/security settings, or is otherwise hard to undo. Add "target" to clicks so the user can see what is being clicked.
- If the user denies an action, do not retry it; choose another approach or finish with done:true and explain.
- Do not type passwords or secrets unless the user gave them in this chat. If you need information from the user, set done:true and ask in "message".
- If the user interrupts with a new instruction it takes priority over your previous plan.

Environment: ${env.session} session${env.desktop ? ` (${env.desktop})` : ''}; AT-SPI ${env.hasAtspi ? 'available' : 'unavailable'}; tools: ${env.tools.join(', ') || 'none detected'}.

USER'S TASK:
${goal}

The first screenshot is attached.`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.7))}\n… [truncated] …\n${s.slice(-Math.floor(n * 0.25))}`;
}

export function describeAction(r: ActionRecord): string {
  const a = r.action;
  switch (a.action) {
    case 'click': case 'double_click': case 'right_click': case 'middle_click': case 'move':
      return `${a.action} (${a.x},${a.y})${a.target ? ` “${a.target}”` : ''}`;
    case 'drag': return `drag (${a.x},${a.y})→(${a.to_x},${a.to_y})`;
    case 'scroll': return `scroll ${a.direction} ×${a.amount}`;
    case 'type': return `type “${(a.text ?? '').slice(0, 60)}${(a.text?.length ?? 0) > 60 ? '…' : ''}”`;
    case 'hotkey': return `hotkey ${(a.keys ?? []).join('+')}`;
    case 'bash': return `bash \`${(a.command ?? '').slice(0, 100)}\``;
    case 'wait': return `wait ${a.seconds}s`;
    case 'atspi_find': case 'atspi_click': return `${a.action} ${a.role ?? ''} “${a.name ?? ''}”`;
    default: return a.action;
  }
}

export interface FollowUp {
  results: ActionRecord[];
  changed: boolean | null;
  screen: { width: number; height: number };
  activeWindow?: string;
  interjection?: string;
  skippedBecauseInterrupted?: number;
}

export function buildFollowUp(f: FollowUp): string {
  const lines: string[] = [];
  f.results.forEach((r, i) => {
    let line = `${i + 1}. ${describeAction(r)} → ${r.status}`;
    if (r.message && r.action.action !== 'bash') line += ` (${clip(r.message, 1800)})`;
    if (r.risk && r.status === 'denied') line += ` — the user DENIED this (${r.risk.reason})`;
    if (r.output && r.action.action === 'bash') {
      line += ` (exit ${r.output.exit_code}${r.output.timed_out ? ', timed out' : ''})`;
      if (r.output.stdout?.trim()) line += `\nstdout:\n${clip(r.output.stdout.trimEnd(), 2500)}`;
      if (r.output.stderr?.trim()) line += `\nstderr:\n${clip(r.output.stderr.trimEnd(), 1200)}`;
    }
    lines.push(line);
  });

  const parts = ['Results of your last actions:', lines.join('\n') || '(none)'];
  if (f.skippedBecauseInterrupted) parts.push(`(${f.skippedBecauseInterrupted} remaining action(s) were cancelled because the user interrupted.)`);
  if (f.activeWindow) parts.push(`Active window: ${f.activeWindow}`);
  if (f.changed === false) parts.push('Note: the screen looks identical to before — your last action may have had no effect.');
  if (f.interjection) {
    parts.push(`THE USER JUST INTERRUPTED with a new instruction (it overrides your previous plan if they conflict):\n“${f.interjection}”`);
  }
  parts.push(`A fresh ${f.screen.width}×${f.screen.height} screenshot is attached. Reply with one \`\`\`json block only.`);
  return parts.join('\n\n');
}

export function buildFormatReminder(error: string): string {
  return `I could not use that reply: ${error}\nReply again with ONLY one \`\`\`json block in the exact format from the first message (keys: thought, actions, done, message).`;
}

export function buildChatPrompt(text: string): string {
  return text;
}
