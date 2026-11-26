/**
 * Interpret a spoken answer to "Approve this action?".
 * Deliberately asymmetric: any denial word wins, so "no, don't do it" or
 * "yes… actually stop" can never be read as approval.
 */
const DENY = [
  'no', 'nope', 'nah', 'deny', 'denied', 'cancel', 'stop', 'abort', 'reject', 'negative', 'dont', 'not', 'never',
  'wait', 'halt', 'decline',
];
const APPROVE = [
  'yes', 'yeah', 'yep', 'yup', 'approve', 'approved', 'confirm', 'confirmed', 'proceed', 'ok', 'okay', 'sure',
  'allow', 'affirmative', 'continue',
];
const APPROVE_PHRASES = ['go ahead', 'do it', 'go for it', 'sounds good', 'that is fine', "that's fine"];

export type VoiceDecision = 'approve' | 'deny' | null;

export function parseVoiceConfirmation(transcript: string): VoiceDecision {
  const norm = transcript.toLowerCase().replace(/don['’]t/g, 'dont').replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  const words = norm.split(' ');
  if (words.some((w) => DENY.includes(w))) return 'deny';
  if (words.some((w) => APPROVE.includes(w)) || APPROVE_PHRASES.some((p) => norm.includes(p))) return 'approve';
  return null;
}
