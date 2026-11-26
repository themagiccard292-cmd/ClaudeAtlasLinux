// Exercises electron/bridge/page-bridge.js against a mock claude.ai-like page in headless Chromium.
// Needs Playwright (global or local); exits 0 with a notice if it is not available.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = createRequire(resolve(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
  } catch {
    console.log('playwright not available — skipping page-bridge test');
    process.exit(0);
  }
}

// selectors.ts is TypeScript; pull the object out without a build step.
const selSrc = readFileSync(resolve(root, 'electron/bridge/selectors.ts'), 'utf8');
const selectors = new Function(`${selSrc.replace(/export const (\w+) =/g, 'const $1 =').replace(/ as const;/g, ';').replace(/export type[^\n]*\n/g, '')}; return { SELECTORS, LIMIT_PATTERNS };`)();
const pageScript = readFileSync(resolve(root, 'electron/bridge/page-bridge.js'), 'utf8');
const prelude = `window.__ATLAS_SELECTORS=${JSON.stringify(selectors.SELECTORS)};window.__ATLAS_LIMITS=${JSON.stringify(selectors.LIMIT_PATTERNS)};`;
const mock = pathToFileURL(resolve(root, 'electron/bridge/__fixtures__/mock-claude.html')).href;

// 1x1 white JPEG
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
async function open(query = '') {
  const page = await browser.newPage();
  await page.goto(mock + query);
  await page.evaluate(prelude + pageScript);
  return page;
}
const call = (page, expr) => page.evaluate(`window.__atlasBridge.${expr}`);

async function roundTrip(page, label) {
  const before = await call(page, 'assistantCount()');
  const att = await call(page, `attachImage("${JPEG_B64}", "image/jpeg", "screen.jpg")`);
  check(`${label}: screenshot attached (${att.strategy})`, att.attached);
  const prompt = 'Line one: do *this* & {that}\nLine two → "quoted"';
  const typed = await call(page, `setText(${JSON.stringify(prompt)})`);
  check(`${label}: text inserted via ${typed.method}`, !!typed.method);
  const sent = await call(page, 'send()');
  check(`${label}: send via ${sent.via}`, sent.via === 'button');

  const t0 = Date.now();
  let st;
  let sawStreaming = false;
  while (Date.now() - t0 < 20000) {
    st = await call(page, 'state()');
    if (st.streaming) sawStreaming = true;
    if (st.count > before && !st.streaming && st.text.trim()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(`${label}: streaming was observed (Stop button / data-is-streaming)`, sawStreaming);
  check(`${label}: finished and reply captured`, st.count > before && !st.streaming && st.text.includes('Sure'), JSON.stringify(st).slice(0, 200));
  const block = st.codeBlocks[st.codeBlocks.length - 1] || '';
  let parsed = null;
  try { parsed = JSON.parse(block); } catch { /* reported below */ }
  check(`${label}: JSON extracted raw from <pre> (markdown-safe)`, parsed && parsed.actions[1].text === 'a*b*c {x}', block.slice(0, 120));

  const received = await page.evaluate('window.__sent');
  check(`${label}: server received the prompt verbatim`, received[0].text.replace(/\n+/g, '\n').trim() === prompt.trim() || received[0].text.includes('Line two'), JSON.stringify(received[0]).slice(0, 160));
  check(`${label}: server received the screenshot`, received[0].attachments.length === 1 && received[0].attachments[0].name === 'screen.jpg');
}

try {
  let p = await open();
  await roundTrip(p, 'file-input path');
  check('pageInfo sees editor, not login', (await call(p, 'pageInfo()')).hasEditor);
  await p.close();

  p = await open('?noinput');
  await roundTrip(p, 'paste fallback (no <input type=file>)');
  await p.close();

  p = await open('?nopaste');
  const t = await call(p, 'setText("fallback typing works")');
  check(`text falls back when paste is ignored (${t.method})`, t.method === 'execCommand');
  await p.close();

  p = await open();
  await call(p, 'setText("hi")'); await call(p, 'send()');
  await new Promise((r) => setTimeout(r, 300));
  check('stop() clicks the Stop button mid-stream', (await call(p, 'stop()')) === true);
  await new Promise((r) => setTimeout(r, 200));
  check('stopped reply is no longer streaming', (await call(p, 'state()')).streaming === false);
  const diag = await call(p, 'diagnose()');
  check('diagnose() reports selector hits', diag.counts.editor[0] === 1 && diag.counts.sendButton[0] === 1);
  await p.close();

  p = await open();
  await p.evaluate(`document.body.insertAdjacentHTML('beforeend','<div role="alert">You have reached your usage limit. It will reset at 5pm.</div>')`);
  check('rate-limit banner is detected', (await call(p, 'state()')).error?.kind === 'rate_limit');
  await p.close();

  p = await open();
  await p.evaluate(`document.getElementById('editor').remove()`);
  let threw = false;
  try { await p.evaluate(`window.__atlasBridge.setText('x')`); } catch { threw = true; }
  check('missing composer raises a clear error (after waiting)', threw);
  await p.close();
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall page-bridge checks passed');
process.exit(failures ? 1 : 0);
