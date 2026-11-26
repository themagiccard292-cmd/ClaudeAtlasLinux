// tsc only emits .ts → .js; copy the raw in-page bridge script next to the compiled bridge code.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(root, 'dist-electron/electron/bridge');
mkdirSync(dest, { recursive: true });
cpSync(resolve(root, 'electron/bridge/page-bridge.js'), resolve(dest, 'page-bridge.js'));
console.log('copied page-bridge.js');
