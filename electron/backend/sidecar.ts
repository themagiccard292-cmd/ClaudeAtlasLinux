import { app } from 'electron';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export interface Sidecar {
  port: number;
  token: string;
  child: ChildProcess;
  command: string;
  stop(): Promise<void>;
}

const READY_MARKER = 'ATLAS_BACKEND_READY';

/** Find a free localhost port (the sidecar is told to bind exactly this one). */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/**
 * Environment for the sidecar (and therefore for every app the agent launches).
 * Inside an AppImage the launcher prepends its own lib/bin dirs to LD_LIBRARY_PATH/PATH, which
 * breaks host programs (firefox, python3-gi, xdotool…), so strip them.
 */
export function cleanChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const appdir = env.APPDIR;
  if (appdir) {
    for (const key of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'GIO_EXTRA_MODULES']) {
      const v = env[key];
      if (v) {
        const kept = v.split(':').filter((p) => p && !p.startsWith(appdir));
        if (kept.length) env[key] = kept.join(':');
        else delete env[key];
      }
    }
  }
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[k];
  return env;
}

/** Make sure the ELF is executable; on a read-only mount copy it to userData first. */
function ensureExecutable(file: string): string {
  try {
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    /* fall through */
  }
  try {
    chmodSync(file, 0o755);
    return file;
  } catch {
    const dir = join(app.getPath('userData'), 'bin');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'backend-linux');
    copyFileSync(file, copy);
    chmodSync(copy, 0o755);
    return copy;
  }
}

export function resolveBackendCommand(): { cmd: string; args: string[]; cwd?: string } {
  const override = process.env.ATLAS_BACKEND_BIN;
  if (override) return { cmd: ensureExecutable(override), args: [] };

  if (app.isPackaged) {
    return { cmd: ensureExecutable(join(process.resourcesPath, 'backend-linux')), args: [] };
  }
  // Development: run the Python sources (venv if present), else a prebuilt binary.
  const root = resolve(__dirname, '..', '..', '..');
  const server = join(root, 'backend', 'server.py');
  const venvPy = join(root, 'backend', '.venv', 'bin', 'python');
  if (existsSync(server)) return { cmd: existsSync(venvPy) ? venvPy : 'python3', args: ['-u', server], cwd: join(root, 'backend') };
  return { cmd: ensureExecutable(join(root, 'backend', 'dist', 'backend-linux')), args: [] };
}

export async function startSidecar(log: (line: string) => void): Promise<Sidecar> {
  const { cmd, args, cwd } = resolveBackendCommand();
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  log(`starting backend: ${cmd} ${args.join(' ')} (port ${port})`);

  const child = spawn(cmd, [...args, '--host', '127.0.0.1', '--port', String(port), '--token', token, '--exit-on-stdin-eof'], {
    cwd,
    env: cleanChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'], // silent: no console window, logs captured below
    windowsHide: true,
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Backend did not become ready within 60s')), 60_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith(READY_MARKER)) {
          clearTimeout(timer);
          ready();
        } else if (line) log(`[backend] ${line}`);
      }
    });
    child.stderr!.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => log(`[backend:err] ${l}`)));
    child.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      fail(new Error(`Backend exited before it was ready (code ${code}, signal ${sig})`));
    });
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    child.stdin?.end(); // EOF on stdin makes the backend exit by itself …
    const t1 = setTimeout(() => child.kill('SIGTERM'), 1500); // … otherwise ask politely …
    const t2 = setTimeout(() => child.kill('SIGKILL'), 4000); // … then force.
    await done;
    clearTimeout(t1);
    clearTimeout(t2);
  };

  return { port, token, child, command: cmd, stop };
}
