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
  } else if (scenario === 'sandbox') {
    reply = st.n === 1
      ? fence({ thought: 'Open a terminal on the sandbox', actions: [
          { action: 'bash', command: "nohup xterm -T AtlasTerm -fa 'DejaVu Sans Mono' -fs 13 -bg '#101820' -fg white -geometry 70x22+60+60 -e bash -c 'echo SANDBOX-OK-4242; sleep 120' >/dev/null 2>&1 & echo $DISPLAY > " + process.env.DISPFILE + "; sleep 1.5" },
          { action: 'click', x: 1100, y: 600, target: 'far corner' }], done: false, message: 'Launching a terminal' })
      : st.n === 2
      ? fence({ thought: 'I can READ the word in the text view; click it by its words', actions: [{ action: 'click_text', text: 'SANDBOX-OK-4242' }], done: false, message: 'Clicking the text I read' })
      : fence({ thought: 'Looks right', actions: [], done: true, message: 'Terminal is open on the sandbox.' });
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
      ...process.env, DISPLAY, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', FAKE_DIR: tmp, MARKER: marker, VICTIM: victim, DISPFILE: join(tmp, 'display.txt'),
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
  await inv('settings:set', { bridgeMode: 'cli', cliPath: fake, stepDelayMs: 100, maxSteps: 6, desktopMode: 'real' });
  await win.waitForFunction(() => !/Sign in with Claude Pro/.test(document.body.innerText), null, { timeout: 10_000 });
  check('CLI mode bypasses the login screen', true);

  // ---- 3. full agent task ----------------------------------------------------------------------
  setScenario('marker');
  const chat = await inv('chat:create');
  await inv('agent:start', { chatId: chat.id, text: 'create the marker file', mode: 'agent' });
  let sawHud = false, sawRunning = false, last, mainVisibleDuringRealTask = false;
  for (let i = 0; i < 120; i++) {
    sawHud ||= app.windows().some((w) => w.url().includes('#/hud'));
    if (sawHud && (await inv('agent:state')).status === 'running') mainVisibleDuringRealTask ||= await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && /index\.html/.test(w.webContents.getURL()) && !/hud/.test(w.webContents.getURL())));
    const st = await inv('agent:state');
    sawRunning ||= st.status === 'running';
    last = await inv('chat:get', chat.id);
    if (st.status === 'idle' && last.messages.some((m) => m.role === 'assistant' && m.kind === 'text')) break;
    await sleep(300);
  }
  check('agent entered running state', sawRunning);
  check('Mini-HUD window was created while working', sawHud);
  check('main window stayed HIDDEN during the real-desktop task (it must not cover the screen or leak into Claude\'s view)', !mainVisibleDuringRealTask);
  check('bash action executed on the real system', existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'atlas-was-here');
  const steps = last.messages.filter((m) => m.kind === 'step');
  check('step recorded with screenshot thumbnail + both actions OK', steps.length >= 1 && !!steps[0].step.screenshot?.startsWith('data:image/jpeg') && steps[0].step.actions.every((a) => a.status === 'ok'), JSON.stringify(steps[0]?.step.actions.map((a) => [a.action.action, a.status, a.message])));
  const click = steps[0]?.step.actions.find((a) => a.action.action === 'click');
  check('click mapped 640,360 (model) → 800,450 (1600x900 screen)', click?.screen?.x === 800 && click?.screen?.y === 450, JSON.stringify(click?.screen));
  check('final assistant answer shown', last.messages.some((m) => m.kind === 'text' && /marker file exists/.test(m.content)));
  const prompts = readFileSync(join(tmp, 'prompts.log'), 'utf8');
  check('first prompt carries the JSON protocol + task + a TEXT view of the screen', /OUTPUT FORMAT/.test(prompts) && /create the marker file/.test(prompts) && /CURRENT SCREEN:\n\[screen\] \d+x\d+/.test(prompts));
  check('prompt is honest: no video, text description, image only when needed', /do NOT receive a video stream/.test(prompts) && /\[text on screen\]/.test(prompts));
  check('empty desktop => NO screenshot was attached at all', execSync(`ls ${join(tmp, 'profile', 'cli-work')}/screen-*.jpg 2>/dev/null | wc -l`).toString().trim() === '0');
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

  // ---- 6b. SANDBOX DESKTOP + LIVE VIEW ---------------------------------------------------------
  await inv('settings:set', { desktopMode: 'sandbox' });
  setScenario('sandbox');
  const chat6 = await inv('chat:create');
  await win.getByText('create the marker file').first().click(); // any chat; then open the new one
  await win.evaluate(() => { window.__events.length = 0; });
  await inv('agent:start', { chatId: chat6.id, text: 'open a terminal on your desktop', mode: 'agent' });
  let sawHud6 = false, mainStayedVisible = true;
  for (let i = 0; i < 160; i++) {
    sawHud6 ||= app.windows().some((w) => w.url().includes('#/hud'));
    const vis = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible() && !w.webContents.getURL().includes('hud') && w.webContents.getURL().includes('index.html')).length);
    mainStayedVisible &&= vis >= 1;
    if ((await inv('agent:state')).status === 'idle' && i > 4) break;
    await sleep(250);
  }
  const ev6 = await events();
  {
    const c6 = await inv('chat:get', chat6.id);
    const summary = c6.messages.map((m) => m.step ? { step: m.step.step, actions: m.step.actions.map((a) => `${a.action.action}:${a.status}${a.message ? ' (' + String(a.message).slice(0, 80) + ')' : ''}`) } : `${m.role}: ${m.content.slice(0, 160)}`);
    const fr = ev6.filter((e) => e.type === 'live:frame');
    console.log('  [debug sandbox task]', JSON.stringify(summary), `| frames=${fr.length} withJpeg=${fr.filter((e) => e.jpeg).length} ended=${fr.filter((e) => e.ended).length} sandboxEvts=${ev6.filter((e) => e.type === 'sandbox').length} fx=${ev6.filter((e) => e.type === 'live:fx').length}`);
  }
  const frames = ev6.filter((e) => e.type === 'live:frame' && e.jpeg);
  const pointers = new Set(ev6.filter((e) => e.type === 'live:frame' && e.pointer).map((e) => e.pointer.map((v) => v.toFixed(2)).join(',')));
  const fxClick = ev6.find((e) => e.type === 'live:fx' && e.fx.kind === 'click');
  check('sandbox desktop started (Xvfb on its own display)', ev6.some((e) => e.type === 'sandbox' && e.state.running && /^:\d+$/.test(e.state.display)), JSON.stringify(ev6.find((e) => e.type === 'sandbox')));
  check('NO HUD window in sandbox mode, main window stays open', !sawHud6 && mainStayedVisible, `hud=${sawHud6} main=${mainStayedVisible}`);
  check(`live video frames reached the UI (${frames.length} JPEG frames)`, frames.length >= 3 && frames[0].w > 0);
  check(`agent pointer travelled through intermediate positions (${pointers.size} distinct)`, pointers.size >= 4);
  check('click effect (ripple) event with normalised coordinates', !!fxClick && fxClick.fx.x > 0.7 && fxClick.fx.y > 0.7, JSON.stringify(fxClick));
  const sbDisplay = existsSync(join(tmp, 'display.txt')) ? readFileSync(join(tmp, 'display.txt'), 'utf8').trim() : '';
  check(`agent's shell ran on the sandbox display (${sbDisplay}), not the real one (${DISPLAY})`, /^:\d+$/.test(sbDisplay) && sbDisplay !== DISPLAY);
  const prompts2 = readFileSync(join(tmp, 'prompts.log'), 'utf8');
  check('prompt tells Claude it is on a private virtual desktop and which apps exist', /PRIVATE VIRTUAL DESKTOP/.test(prompts2) && /Applications installed here:/.test(prompts2));
  // What CLAUDE received: a TEXT view of the sandbox, containing the word printed in the sandbox terminal
  const lastRun = prompts2.slice(prompts2.lastIndexOf('--- call 1 ---'));
  const OCR_WORD = /SANDBOX\s*-?\s*OK\s*-?\s*4242/;
  const turn2 = lastRun.split('--- call 2 ---')[1] ?? '';
  check('Claude read the sandbox terminal as TEXT (windows + OCR), no screenshot needed', /AtlasTerm/.test(turn2) && OCR_WORD.test(turn2) && /\[text on screen\]/.test(turn2), turn2.slice(0, 600));
  check('timeline told Claude what changed (window opened)', /\[what changed since your last step\]/.test(turn2) && /window opened: “AtlasTerm”/.test(turn2), turn2.slice(0, 900));
  const turn3 = lastRun.split('--- call 3 ---')[1] ?? '';
  check('Claude clicked by READING: click_text found the words and clicked them', /clicked the text “SANDBOX\s*-?\s*OK\s*-?\s*4242”/.test(turn3), turn3.slice(0, 500));
  const clicks = ev6.filter((e) => e.type === 'live:fx' && e.fx.kind === 'click');
  check('a second click effect landed on the terminal text (left/top of the screen)', clicks.length >= 2 && clicks[clicks.length - 1].fx.x < 0.5 && clicks[clicks.length - 1].fx.y < 0.5, JSON.stringify(clicks.map((c) => [c.fx.x, c.fx.y])));
  check('real desktop untouched: no terminal on the real display', execSync(`DISPLAY=${DISPLAY} xwininfo -root -tree 2>/dev/null | grep -ci xterm || true`).toString().trim() === '0');
  const perceptionEv = ev6.filter((e) => e.type === 'perception');
  check(`UI received Claude's view each turn (${perceptionEv.length} perception events)`, perceptionEv.length >= 2 && OCR_WORD.test(perceptionEv[perceptionEv.length - 1].text));
  await win.getByText('What Claude sees').first().waitFor({ timeout: 8000 }).then(() => check('“What Claude sees” panel is shown in the app', true)).catch(() => check('“What Claude sees” panel is shown in the app', false));
  // the renderer shows the live panel with a painted canvas
  const panel = win.locator('aside[aria-label="Live view"]');
  await panel.waitFor({ timeout: 8000 }).then(() => check('Live view panel is visible in the app', true)).catch(() => check('Live view panel is visible in the app', false));
  const painted = await win.evaluate(() => { const c = document.querySelector('aside[aria-label="Live view"] canvas'); if (!c) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4000) n += d[i] + d[i + 1] + d[i + 2]; return n > 0; });
  check('canvas contains the streamed desktop image (CSP-safe decode)', painted);
  await win.screenshot({ path: join(tmp, 'live.png') });
  if (shotsDir) await win.screenshot({ path: join(shotsDir, 'electron-live-view.png') });

  // ---- 7. chats persisted to disk ---------------------------------------------------------------------
  check('chat history persisted as JSON on disk', existsSync(join(tmp, 'profile', 'chats', `${chat.id}.json`)) || (await sleep(1200), existsSync(join(tmp, 'profile', 'chats', `${chat.id}.json`))));
} catch (e) {
  console.error('E2E crashed:', e);
  failures++;
} finally {
  await app?.close().catch(() => undefined);
  await sleep(1500);
  const orphan = execSync('pgrep -f "[s]erver.py --host 127.0.0.1|[b]ackend-linux --host 127.0.0.1|[X]vfb -displayfd" || true').toString().trim();
  check('sidecar exits with the app (no orphan)', orphan === '', orphan);
  xvfb.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall electron e2e checks passed');
process.exit(failures ? 1 : 0);
