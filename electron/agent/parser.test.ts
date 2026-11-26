import { describe, expect, it } from 'vitest';
import { balancedObjects, ParseError, parseAgentReply, sanitizeAction } from './parser';
import { parseVoiceConfirmation } from './voiceConfirm';

const fenced = (o: unknown) => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

describe('parseAgentReply', () => {
  it('parses a fenced json block', () => {
    const r = parseAgentReply(
      fenced({ thought: 'open it', actions: [{ action: 'click', x: 10, y: 20 }], done: false, message: 'Clicking' }),
    );
    expect(r.actions).toEqual([{ action: 'click', x: 10, y: 20, button: 'left' }]);
    expect(r.done).toBe(false);
    expect(r.message).toBe('Clicking');
  });

  it('prefers rendered code blocks and tolerates a language/copy prefix', () => {
    const r = parseAgentReply('Sure!', ['json\nCopy\n{"actions":[{"action":"hotkey","keys":["ctrl","l"]}],"done":false}']);
    expect(r.actions[0]).toEqual({ action: 'hotkey', keys: ['ctrl', 'l'] });
  });

  it('extracts raw JSON surrounded by prose', () => {
    const r = parseAgentReply('Here you go: {"actions":[{"action":"type","text":"hello"}],"done":true,"message":"ok"} hope it helps');
    expect(r.actions[0].text).toBe('hello');
    expect(r.done).toBe(true);
  });

  it('is not fooled by braces inside strings', () => {
    const cmd = 'echo "{not json}" && printf "}"';
    const r = parseAgentReply(fenced({ actions: [{ action: 'bash', command: cmd }], done: false }));
    expect(r.actions[0].command).toBe(cmd);
    expect(balancedObjects('x {"a":"}{"} y {"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}']);
  });

  it('repairs trailing commas and smart quotes', () => {
    const r = parseAgentReply('{"actions":[{"action":"wait","seconds":2,},],"done":false,}');
    expect(r.actions[0]).toEqual({ action: 'wait', seconds: 2 });
    const q = parseAgentReply('{\u201Cactions\u201D:[{\u201Caction\u201D:\u201Cwait\u201D}],\u201Cdone\u201D:false}');
    expect(q.actions[0].action).toBe('wait');
  });

  it('accepts a single bare action and coordinate arrays', () => {
    const r = parseAgentReply('{"action":"click","coordinate":[640,360],"button":"right"}');
    expect(r.actions[0]).toEqual({ action: 'click', x: 640, y: 360, button: 'right' });
  });

  it('treats an actionless reply with a message as done', () => {
    const r = parseAgentReply('{"message":"All finished."}');
    expect(r.done).toBe(true);
    expect(r.actions).toEqual([]);
  });

  it('uses the LAST valid reply when the model emits several', () => {
    const r = parseAgentReply(
      fenced({ actions: [{ action: 'wait' }], done: false, message: 'first' }) + '\nActually:\n' +
        fenced({ actions: [{ action: 'wait', seconds: 3 }], done: false, message: 'second' }),
    );
    expect(r.message).toBe('second');
  });

  it('caps the number of actions per turn', () => {
    const many = Array.from({ length: 20 }, () => ({ action: 'wait' }));
    expect(parseAgentReply(fenced({ actions: many, done: false })).actions).toHaveLength(6);
  });

  it('rejects replies with no usable JSON', () => {
    expect(() => parseAgentReply('I cannot help with that.')).toThrow(ParseError);
    expect(() => parseAgentReply('{"foo": 1}')).toThrow(ParseError);
  });

  it('rejects unknown actions with a helpful message', () => {
    expect(() => parseAgentReply('{"actions":[{"action":"format_disk"}],"done":false}')).toThrow(/Unknown action "format_disk"/);
  });
});

describe('sanitizeAction (security boundary)', () => {
  it('strips approval / unknown fields so the model cannot bypass confirmation', () => {
    const a = sanitizeAction({ action: 'bash', command: 'sudo ls', approved: true, approve: true, confirmed: true, skip_confirmation: true });
    expect(a).toEqual({ action: 'bash', command: 'sudo ls' });
    expect(JSON.stringify(a)).not.toMatch(/approv|confirm/);
  });

  it('keeps the model-supplied requires_confirmation flag', () => {
    const a = sanitizeAction({ action: 'click', x: 1, y: 1, requires_confirmation: true, reason: 'Sends the email', target: 'Send' });
    expect(a.requires_confirmation).toBe(true);
    expect(a.reason).toBe('Sends the email');
  });

  it('validates numbers and ranges', () => {
    expect(() => sanitizeAction({ action: 'click', x: 'abc', y: 1 })).toThrow(ParseError);
    expect(() => sanitizeAction({ action: 'click', x: 1, y: 1, button: 'laser' })).toThrow(ParseError);
    expect(sanitizeAction({ action: 'scroll', amount: 9999 }).amount).toBe(50);
    expect(sanitizeAction({ action: 'bash', command: 'ls', timeout: 99999 }).timeout).toBe(600);
    expect(sanitizeAction({ action: 'wait', seconds: 500 }).seconds).toBe(30);
  });

  it('normalises hotkey forms', () => {
    expect(sanitizeAction({ action: 'hotkey', keys: 'ctrl+shift+t' }).keys).toEqual(['ctrl', 'shift', 't']);
    expect(sanitizeAction({ action: 'key', key: 'Return' })).toEqual({ action: 'hotkey', keys: ['Return'] });
  });

  it('converts double:true into double_click', () => {
    expect(sanitizeAction({ action: 'click', x: 1, y: 2, double: true }).action).toBe('double_click');
  });

  it('requires a locator for atspi actions', () => {
    expect(() => sanitizeAction({ action: 'atspi_click' })).toThrow(ParseError);
    expect(sanitizeAction({ action: 'atspi_click', name: 'Save' })).toMatchObject({ name: 'Save', scope: 'all', index: 0 });
  });
});

describe('parseVoiceConfirmation', () => {
  it.each([
    ['yes', 'approve'], ['Yes, go ahead.', 'approve'], ['okay do it', 'approve'], ['approve', 'approve'],
    ['no', 'deny'], ["No, don't do that", 'deny'], ['cancel that', 'deny'], ['stop', 'deny'],
    ['yes actually stop', 'deny'], ['do not proceed', 'deny'], ['yeah wait no', 'deny'],
    ['banana', null], ['', null],
  ])('%j → %s', (said, expected) => {
    expect(parseVoiceConfirmation(said)).toBe(expected);
  });
});
