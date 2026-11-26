// End-to-end test: real Electron + real Python sidecar + Xvfb, with a FAKE `claude` CLI standing in
// for the model (the CLI bridge pipes prompts to it exactly like the real one).
//
//   xvfb is started automatically.   node scripts/e2e-electron.mjs [--shots <dir>]
//
// Skips (exit 0) when Xvfb / Playwright / the Electron binary are unavailable.
import { execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const skip = (why) => { console.log(`skipping electron e2e: ${why}`); process.exit(0); };
let electron;
try {
  const req = createRequire(import.meta.url);
  try { ({ _electron: electron } = req('playwright')); } catch {
    ({ _electron: electron } = createRequire(resolve(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
  }
} catch { skip('playwright not available'); }
// ATLAS_E2E_APP=release/linux-unpacked/claude-os-agent tests the PACKAGED app (asar + bundled backend-linux)
const packagedApp = process.env.ATLAS_E2E_APP ? resolve(root, process.env.ATLAS_E2E_APP) : null;
const electronBin = packagedApp ?? join(root, 'node_modules/electron/dist/electron');
if (!existsSync(electronBin)) skip(packagedApp ? `packaged app not found: ${packagedApp}` : 'electron binary not installed');
try { execSync('which Xvfb', { stdio: 'ignore' }); } catch { skip('Xvfb not installed'); }
if (!existsSync(join(root, 'dist/index.html')) || !existsSync(join(root, 'dist-electron/electron/main.js'))) skip('run `npm run build` first');

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
const marker = join(tmp, 'marker.txt');
const victim = join(tmp, 'victim.txt');
writeFileSync(victim, 'do not delete me');

// ------------------------------------------------------------------ fake `claude` CLI
const fake = join(tmp, 'claude');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const dir = process.env.FAKE_DIR;
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const stateFile = dir + '/state.json';
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { n: 0 };
  st.n++; fs.writeFileSync(stateFile, JSON.stringify(st));
  fs.appendFileSync(dir + '/env.log', ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'].map(k => process.env[k] ? 'LEAK:' + k : 'clean:' + k).join(' ') + '\\n');
  fs.appendFileSync(dir + '/prompts.log', '--- call ' + st.n + ' ---\\n' + input + '\\n');
  const scenario = fs.readFileSync(dir + '/scenario', 'utf8').trim();
  const fence = (o) => '\`\`\`json\\n' + JSON.stringify(o) + '\\n\`\`\`';
  let reply;
  if (scenario === 'marker') {
    reply = st.n === 1
      ? fence({ thought: 'Create the marker file with bash', actions: [{ action: 'bash', command: 'echo atlas-was-here > ' + process.env.MARKER }, { action: 'click', x: 640, y: 360, target: 'centre of screen' }], done: false, message: 'Creating the file' })
      : fence({ thought: 'Verified', actions: [], done: true, message: 'All done — the marker file exists.' });
  } else if (scenario === 'rm') {
    reply = st.n === 1
      ? fence({ thought: 'Delete the victim', actions: [{ action: 'bash', command: 'rm -f ' + process.env.VICTIM }], done: false, message: 'Deleting' })
      : fence({ thought: 'ok', actions: [], done: true, message: 'Finished after the answer.' });
  } else if (scenario === 'badjson') {
    reply = st.n <= 2 ? 'I will just describe it in prose.' : fence({ actions: [], done: true, message: 'recovered after reminders' });
  } else { reply = fence({ actions: [], done: true, message: 'noop' }); }
  process.stdout.write(JSON.stringify({ result: reply, session_id: 'fake-session', is_error: false }) + '\\n');
});
`);
chmodSync(fake, 0o755);
const setScenario = (name) => { writeFileSync(join(tmp, 'scenario'), name); writeFileSync(join(tmp, 'state.json'), '{"n":0}'); };

// ------------------------------------------------------------------------------ Xvfb
const DISPLAY = ':84';
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x900x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
await sleep(1200);

let app;
try {
  app = await electron.launch({
    executablePath: electronBin,
    args: [...(packagedApp ? [] : [root]), '--no-sandbox', `--user-data-dir=${join(tmp, 'profile')}`],
    env: {
      ...process.env, DISPLAY, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', FAKE_DIR: tmp, MARKER: marker, VICTIM: victim,
      ELECTRON_ENABLE_LOGGING: '0',
      // poison the environment: the CLI bridge must scrub these so usage can never bill an API account
      ANTHROPIC_API_KEY: 'sk-ant-must-not-leak', ANTHROPIC_AUTH_TOKEN: 'tok-must-not-leak', ANTHROPIC_BASE_URL: 'https://example.invalid',
    },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const inv = (ch, ...args) => win.evaluate(([c, a]) => window.atlas.invoke(c, ...a), [ch, args]);
  await win.evaluate(() => { window.__events = []; window.atlas.onEvent((e) => window.__events.push(e)); });
  const events = () => win.evaluate(() => window.__events);

  // ---- 1. app boots, sidecar spawns and is reachable --------------------------------------------
  let backend;
  for (let i = 0; i < 120; i++) {
    backend = await inv('backend:state');
    if (backend.status === 'ready' || backend.status === 'error') break;
    await sleep(500);
  }
  check(`backend sidecar started and connected${packagedApp ? ' (bundled backend-linux ELF)' : ''}`, backend.status === 'ready', JSON.stringify(backend).slice(0, 300));
  if (packagedApp) check('packaged run uses the frozen backend', backend.info?.frozen === true, JSON.stringify(backend.info?.frozen));
  check('X11 detected, xdotool driver, hotkeys listening', backend.info?.session.kind === 'x11' && backend.info.input.driver === 'xdotool' && !!backend.info.hotkeys.source, JSON.stringify(backend.info?.hotkeys));
  const auth = await inv('auth:state');
  check('first launch is signed out (login screen)', auth.status === 'signed_out', JSON.stringify(auth));
  const loginText = await win.locator('body').innerText();
  check('"Sign in with Claude Pro" screen is shown', /Sign in with Claude Pro/.test(loginText));
  if (shotsDir) await win.screenshot({ path: join(shotsDir, 'electron-login.png') });

  // ---- 2. switch to CLI bridge (fake claude) -----------------------------------------------------
  await inv('settings:set', { bridgeMode: 'cli', cliPath: fake, stepDelayMs: 100, maxSteps: 6 });
  await win.waitForFunction(() => !/Sign in with Claude Pro/.test(document.body.innerText), null, { timeout: 10_000 });
  check('CLI mode bypasses the login screen', true);

  // ---- 3. full agent task ----------------------------------------------------------------------
  setScenario('marker');
  const chat = await inv('chat:create');
  await inv('agent:start', { chatId: chat.id, text: 'create the marker file', mode: 'agent' });
  let sawHud = false, sawRunning = false, last;
  for (let i = 0; i < 120; i++) {
    sawHud ||= app.windows().some((w) => w.url().includes('#/hud'));
    const st = await inv('agent:state');
    sawRunning ||= st.status === 'running';
    last = await inv('chat:get', chat.id);
    if (st.status === 'idle' && last.messages.some((m) => m.role === 'assistant' && m.kind === 'text')) break;
    await sleep(300);
  }
  check('agent entered running state', sawRunning);
  check('Mini-HUD window was created while working', sawHud);
  check('bash action executed on the real system', existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'atlas-was-here');
  const steps = last.messages.filter((m) => m.kind === 'step');
  check('step recorded with screenshot thumbnail + both actions OK', steps.length >= 1 && !!steps[0].step.screenshot?.startsWith('data:image/jpeg') && steps[0].step.actions.every((a) => a.status === 'ok'), JSON.stringify(steps[0]?.step.actions.map((a) => [a.action.action, a.status, a.message])));
  const click = steps[0]?.step.actions.find((a) => a.action.action === 'click');
  check('click mapped 640,360 (model) → 800,450 (1600x900 screen)', click?.screen?.x === 800 && click?.screen?.y === 450, JSON.stringify(click?.screen));
  check('final assistant answer shown', last.messages.some((m) => m.kind === 'text' && /marker file exists/.test(m.content)));
  const prompts = readFileSync(join(tmp, 'prompts.log'), 'utf8');
  check('first prompt carries the JSON protocol + task + screenshot path', /OUTPUT FORMAT/.test(prompts) && /create the marker file/.test(prompts) && /screen-\d+\.jpg/.test(prompts));
  check('follow-up prompt reports action results', /Results of your last actions/.test(prompts) && /bash `echo atlas-was-here/.test(prompts));
  const envLog = readFileSync(join(tmp, 'env.log'), 'utf8');
  check('API-key env vars are scrubbed before the CLI runs (subscription auth only)', envLog.includes('clean:ANTHROPIC_API_KEY') && !envLog.includes('LEAK'), envLog);
  await sleep(500);
  check('HUD hidden and main window restored afterwards', !app.windows().some((w) => w.url().includes('#/hud') && !w.isClosed()) || (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)) === 1);
  // the real renderer must display what happened: open the chat and look for the step card + answer
  await win.getByText('create the marker file').first().click();
  await win.getByText('Step 1').first().waitFor({ timeout: 10_000 }).then(() => check('renderer shows the “Step 1” action accordion', true)).catch(() => check('renderer shows the “Step 1” action accordion', false));
  await win.getByText('Step 1').first().click();
  check('expanded step shows the bash command and clicked screen coordinates', (await win.locator('body').innerText()).includes('echo atlas-was-here') && /\(800, 450\)/.test(await win.locator('body').innerText()));
  if (shotsDir) await win.screenshot({ path: join(shotsDir, 'electron-task-done.png') });

  // ---- 4. destructive action → approval gate -----------------------------------------------------
  setScenario('rm');
  const chat2 = await inv('chat:create');
  await win.evaluate(() => { window.__events.length = 0; });
  await inv('agent:start', { chatId: chat2.id, text: 'delete the victim file', mode: 'agent' });
  let confirmEvt;
  for (let i = 0; i < 80 && !confirmEvt; i++) {
    confirmEvt = (await events()).find((e) => e.type === 'confirm' && e.request);
    await sleep(250);
  }
  check('rm requires approval (confirm event with reason)', !!confirmEvt && /Deletes files/.test(confirmEvt.request.reason), JSON.stringify(confirmEvt));
  check('file still exists while approval is pending', existsSync(victim));
  const hudWin = app.windows().find((w) => w.url().includes('#/hud'));
  check('HUD shows the approval card with Approve / Deny', !!hudWin && (await hudWin.locator('body').innerText().catch(() => '')).includes('Approve this action'));
  // readability: the command box text must contrast with its background (regression: light-on-cream)
  const contrast = await hudWin.evaluate(() => {
    const el = document.querySelector('[role=alertdialog] pre');
    const lum = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const cs = getComputedStyle(el);
    const bg = getComputedStyle(document.querySelector('[role=alertdialog]')).backgroundColor;
    const a = lum(cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? bg : cs.backgroundColor), b = lum(cs.color);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  check(`HUD approval command text is readable (contrast ${contrast.toFixed(1)}:1 ≥ 4.5)`, contrast >= 4.5);
  if (shotsDir && hudWin) await hudWin.screenshot({ path: join(shotsDir, 'electron-hud-confirm.png') });
  await inv('agent:confirm', { id: confirmEvt.request.id, approved: false });
  for (let i = 0; i < 80; i++) { if ((await inv('agent:state')).status === 'idle') break; await sleep(250); }
  const c2 = await inv('chat:get', chat2.id);
  check('DENY: file was NOT deleted', existsSync(victim));
  check('denied action recorded as denied', c2.messages.some((m) => m.step?.actions.some((a) => a.status === 'denied')));

  // approve path
  setScenario('rm');
  const chat3 = await inv('chat:create');
  await win.evaluate(() => { window.__events.length = 0; });
  await inv('agent:start', { chatId: chat3.id, text: 'delete the victim file again', mode: 'agent' });
  confirmEvt = undefined;
  for (let i = 0; i < 80 && !confirmEvt; i++) { confirmEvt = (await events()).find((e) => e.type === 'confirm' && e.request); await sleep(250); }
  await inv('agent:confirm', { id: confirmEvt.request.id, approved: true });
  for (let i = 0; i < 80; i++) { if ((await inv('agent:state')).status === 'idle') break; await sleep(250); }
  check('APPROVE: file deleted after approval', !existsSync(victim));

  // ---- 5. malformed model output is retried with a format reminder ------------------------------------
  setScenario('badjson');
  const chat4 = await inv('chat:create');
  await inv('agent:start', { chatId: chat4.id, text: 'say hi', mode: 'agent' });
  for (let i = 0; i < 80; i++) { if ((await inv('agent:state')).status === 'idle' && i > 3) break; await sleep(250); }
  const c4 = await inv('chat:get', chat4.id);
  check('prose-only replies trigger reminders, then recover', c4.messages.some((m) => /recovered after reminders/.test(m.content)), JSON.stringify(c4.messages.map((m) => m.content.slice(0, 80))));

  // ---- 6. kill switch halts a long-running action -------------------------------------------------------
  writeFileSync(join(tmp, 'scenario'), 'sleep');
  writeFileSync(fake, readFileSync(fake, 'utf8').replace("} else { reply", "} else if (scenario === 'sleep') { reply = fence({ actions: [{ action: 'bash', command: 'sleep 60' }], done: false }); } else { reply"));
  const chat5 = await inv('chat:create');
  const t0 = Date.now();
  await inv('agent:start', { chatId: chat5.id, text: 'sleep a minute', mode: 'agent' });
  for (let i = 0; i < 40; i++) { if ((await inv('chat:get', chat5.id)).messages.some((m) => m.step?.actions.some((a) => a.status === 'running'))) break; await sleep(250); }
  await inv('kill:trigger');
  for (let i = 0; i < 40; i++) { if ((await inv('agent:state')).status === 'idle') break; await sleep(250); }
  const c5 = await inv('chat:get', chat5.id);
  check('kill switch aborted the 60 s action within seconds', Date.now() - t0 < 25_000 && c5.messages.some((m) => /Emergency stop|Stopped/.test(m.content)), `${Date.now() - t0}ms ${JSON.stringify(c5.messages.map((m) => m.content.slice(0, 60)))}`);
  check('no stray `sleep 60` left running', execSync('pgrep -f "[s]leep 60" || true').toString().trim() === '');

  // ---- 7. chats persisted to disk ---------------------------------------------------------------------
  check('chat history persisted as JSON on disk', existsSync(join(tmp, 'profile', 'chats', `${chat.id}.json`)) || (await sleep(1200), existsSync(join(tmp, 'profile', 'chats', `${chat.id}.json`))));
} catch (e) {
  console.error('E2E crashed:', e);
  failures++;
} finally {
  await app?.close().catch(() => undefined);
  await sleep(1500);
  const orphan = execSync('pgrep -f "[s]erver.py --host 127.0.0.1|[b]ackend-linux --host 127.0.0.1" || true').toString().trim();
  check('sidecar exits with the app (no orphan)', orphan === '', orphan);
  xvfb.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall electron e2e checks passed');
process.exit(failures ? 1 : 0);
