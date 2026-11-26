import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../shared/types';
import { isNewer, notesToText, reduceUpdate } from './updateState';

const base: UpdateState = { status: 'idle', currentVersion: '1.2.0' };

describe('reduceUpdate', () => {
  it('walks check → available → downloading → downloaded', () => {
    let s = reduceUpdate(base, { type: 'checking' });
    expect(s.status).toBe('checking');
    s = reduceUpdate(s, { type: 'available', version: '1.3.0', notes: '<p>Faster</p>' }, 1000);
    expect(s).toMatchObject({ status: 'available', version: '1.3.0', notes: 'Faster', checkedAt: 1000 });
    s = reduceUpdate(s, { type: 'progress', percent: 41.6, bytesPerSecond: 5e6 });
    expect(s).toMatchObject({ status: 'downloading', progress: 42 });
    s = reduceUpdate(s, { type: 'downloaded', version: '1.3.0' });
    expect(s).toMatchObject({ status: 'downloaded', progress: 100, version: '1.3.0', notes: 'Faster' });
  });

  it('a later check never knocks a finished download back', () => {
    const done = reduceUpdate(base, { type: 'downloaded', version: '1.3.0' });
    expect(reduceUpdate(done, { type: 'checking' }).status).toBe('downloaded');
    expect(reduceUpdate(done, { type: 'none' }).status).toBe('downloaded');
    const err = reduceUpdate(done, { type: 'error', message: 'offline' });
    expect(err.status).toBe('downloaded');
    expect(err.error).toBe('offline');
  });

  it('errors and "up to date" are recorded', () => {
    expect(reduceUpdate(base, { type: 'error', message: 'boom' })).toMatchObject({ status: 'error', error: 'boom' });
    expect(reduceUpdate({ ...base, status: 'checking' }, { type: 'none' }, 5)).toMatchObject({ status: 'none', checkedAt: 5 });
  });

  it('clamps progress', () => {
    expect(reduceUpdate(base, { type: 'progress', percent: 250, bytesPerSecond: 1 }).progress).toBe(100);
    expect(reduceUpdate(base, { type: 'progress', percent: -4, bytesPerSecond: 1 }).progress).toBe(0);
  });
});

describe('notesToText', () => {
  it('strips html and entities', () => {
    expect(notesToText('<h2>New</h2><ul><li>Live view &amp; cursor</li><li>Fixes</li></ul>')).toBe('New\nLive view & cursor\nFixes');
  });
  it('accepts the per-version array form', () => {
    expect(notesToText([{ version: '1.3.0', note: 'Hello' }, 'World'])).toBe('Hello\nWorld');
  });
  it('truncates and handles empties', () => {
    expect(notesToText('x'.repeat(2000))!.length).toBeLessThanOrEqual(701);
    expect(notesToText('')).toBeUndefined();
    expect(notesToText(undefined)).toBeUndefined();
  });
});

describe('isNewer', () => {
  it.each([
    ['1.3.0', '1.2.0', true], ['1.2.1', '1.2.0', true], ['2.0.0', '1.99.9', true], ['1.10.0', '1.9.0', true],
    ['1.2.0', '1.2.0', false], ['1.1.9', '1.2.0', false], ['1.2.0', '1.2.0-beta.1', true], ['1.2.0-beta.1', '1.2.0', false],
    ['v1.3.0', '1.2.0', true],
  ])('%s vs %s → %s', (a, b, expected) => expect(isNewer(a, b)).toBe(expected));
});
