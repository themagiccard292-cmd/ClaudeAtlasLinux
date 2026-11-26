// End-to-end test of AUTO-UPDATE with the real AppImage and a local update feed (no internet, no GitHub).
//
//   APPIMAGE_EXTRACT_AND_RUN=1 node scripts/e2e-update.mjs          (needs `npm run dist` first)
//
// The app is run from a temp COPY of the AppImage (installing an update replaces the file).
// Covers: up-to-date, available (+release notes), manual download with progress, "Restart to update"
// (file really swapped, app relaunches, old sidecar gone), unreachable feed, and "checks disabled".
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = (why) => { console.log(`skipping update e2e: ${why}`); process.exit(0); };
let electron;
try {
  const req = createRequire(import.meta.url);
  try { ({ _electron: electron } = req('playwright')); } catch {
    ({ _electron: electron } = createRequire(resolve(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
  }
} catch { skip('playwright not available'); }
try { execSync('which Xvfb', { stdio: 'ignore' }); } catch { skip('Xvfb not installed'); }
const srcAppImage = join(root, 'release/Claude-OS-Agent.AppImage');
if (!existsSync(srcAppImage)) skip('build the AppImage first (./build.sh)');

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64');
const currentVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const tmp = mkdtempSync(join(tmpdir(), 'atlas-upd-'));
const appCopy = join(tmp, 'Claude-OS-Agent.AppImage');
copyFileSync(srcAppImage, appCopy);
const originalHash = sha512(appCopy);

// ------------------------------------------------------------------ the "release" served locally
const feedDir = join(tmp, 'feed');
mkdirSync(feedDir);
const feedFile = join(feedDir, 'Claude-OS-Agent.AppImage');
copyFileSync(srcAppImage, feedFile);
appendFileSync(feedFile, Buffer.alloc(32, 7)); // different bytes => we can prove the swap happened
const feedHash = sha512(feedFile);
let feedVersion = '99.0.0';
let feedDown = false;
const writeYml = () => writeFileSync(join(feedDir, 'latest-linux.yml'), [
  `version: ${feedVersion}`, 'files:', '  - url: Claude-OS-Agent.AppImage', `    sha512: ${feedHash}`, `    size: ${statSync(feedFile).size}`,
  'path: Claude-OS-Agent.AppImage', `sha512: ${feedHash}`, `releaseDate: '2026-01-01T00:00:00.000Z'`,
  `releaseNotes: '<h3>What is new</h3><ul><li>Gliding cursor &amp; live view</li><li>Auto-update</li></ul>'`, ''].join('\n'));
writeYml();

let hits = [];
const server = createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  if (feedDown) { res.writeHead(503); return res.end('down'); }
  const file = join(feedDir, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!file.startsWith(feedDir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = +range[1], end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  // throttle the big file a little so a progress bar is observable
  res.writeHead(200, { 'content-length': size, 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' });
  const stream = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  stream.on('data', (chunk) => { stream.pause(); res.write(chunk, () => setTimeout(() => stream.resume(), file.endsWith('.AppImage') ? 60 : 0)); });
  stream.on('end', () => res.end());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feedUrl = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------------------------- app under test
const DISPLAY = ':83';
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1500x900x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
await sleep(1200);
const mainPids = () => execSync('ps -eo pid,args').toString().split('\n').filter((l) => /claude-os-agent/.test(l) && !/--type=/.test(l) && !/ps -eo|e2e-update|grep/.test(l)).map((l) => +l.trim().split(/\s+/)[0]);

let app, relaunched = [];
try {
  const launch = (extraEnv = {}) => electron.launch({
    executablePath: appCopy,
    args: ['--no-sandbox', `--user-data-dir=${join(tmp, 'profile')}`],
    env: { ...process.env, DISPLAY, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', APPIMAGE_EXTRACT_AND_RUN: '1',
      ATLAS_UPDATE_URL: feedUrl, ATLAS_UPDATE_DELAY_MS: '600000', ...extraEnv },
    timeout: 90_000,
  });
  app = await launch();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const inv = (ch, ...a) => win.evaluate(([c, args]) => window.atlas.invoke(c, ...args), [ch, a]);
  await inv('settings:set', { bridgeMode: 'cli', updates: { check: false, autoDownload: false, channel: 'stable' } });
  await win.waitForFunction(() => !/Sign in with Claude Pro/.test(document.body.innerText), null, { timeout: 15_000 });
  const upd = async () => inv('update:state');

  // ---- 0. state before anything
  let st = await upd();
  check(`updater is active in the packaged app (method: ${st.method})`, st.status !== 'disabled' && st.method === 'appimage', JSON.stringify(st));
  check(`reports its own version (${currentVersion})`, st.currentVersion === currentVersion, st.currentVersion);

  // ---- 1. already up to date
  feedVersion = currentVersion; writeYml();
  st = await inv('update:check');
  check('feed has the same version → "Up to date"', st.status === 'none', JSON.stringify(st));

  // ---- 2. newer version offered; auto-download OFF so it waits for the user
  feedVersion = '99.0.0'; writeYml();
  st = await inv('update:check');
  check('newer version detected → status "available" with version', st.status === 'available' && st.version === '99.0.0', JSON.stringify(st));
  check('release notes converted from HTML to plain text', /What is new/.test(st.notes ?? '') && /Gliding cursor & live view/.test(st.notes ?? '') && !/</.test(st.notes ?? ''), st.notes);
  await win.getByText('Version 99.0.0').first().waitFor({ timeout: 8000 }).then(() => check('update banner shows "Version 99.0.0 is available"', true)).catch(() => check('update banner shows "Version 99.0.0 is available"', false));
  check('nothing was downloaded without consent', !hits.some((h) => h.includes('.AppImage')), hits.join(' | '));

  // ---- 3. click Download → progress → ready
  await win.getByRole('button', { name: 'Download', exact: true }).click();
  let sawProgress = false, ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    st = await upd();
    if (st.status === 'downloading' && st.progress > 0 && st.progress < 100) sawProgress = true;
    ready = st.status === 'downloaded';
    await sleep(250);
  }
  check('download progress was reported (0 < % < 100)', sawProgress);
  check('download finished → status "downloaded"', ready, JSON.stringify(st));
  await win.getByRole('button', { name: 'Restart to update', exact: true }).waitFor({ timeout: 8000 }).then(() => check('banner offers "Restart to update"', true)).catch(() => check('banner offers "Restart to update"', false));
  await win.screenshot({ path: join(tmp, 'update-ready.png') });

  // ---- 4. guard rails
  feedDown = true;
  st = await inv('update:check');
  check('feed unreachable AFTER download → downloaded update is kept (not lost)', st.status === 'downloaded', JSON.stringify(st));
  feedDown = false;

  // ---- 5. restart to update: file swapped, app relaunches, old sidecar gone
  const before = mainPids();
  check('app copy is unchanged before installing', sha512(appCopy) === originalHash);
  await win.getByRole('button', { name: 'Restart to update', exact: true }).click().catch(() => undefined);
  let swapped = false;
  for (let i = 0; i < 120 && !swapped; i++) { swapped = sha512(appCopy) === feedHash; if (!swapped) await sleep(250); }
  check('AppImage file was replaced by the downloaded update', swapped);
  let fresh = [];
  for (let i = 0; i < 80 && !fresh.length; i++) { fresh = mainPids().filter((p) => !before.includes(p)); if (!fresh.length) await sleep(250); }
  relaunched = fresh;
  check('app relaunched itself (new main process)', fresh.length > 0, `before=${before} now=${mainPids()}`);
  await sleep(2500);
  const oldAlive = before.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  check('old instance exited (single-instance lock released)', oldAlive.length === 0, `still alive: ${oldAlive}`);
} catch (e) {
  console.error('update e2e crashed:', e);
  failures++;
} finally {
  await app?.close().catch(() => undefined);
  try { execSync(`pkill -f "${tmp}" || true; pkill -f appimage_extracted || true; pkill -f "[b]ackend-linux --host" || true`, { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(800);
  server.close();
  xvfb.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall auto-update checks passed');
process.exit(failures ? 1 : 0);
