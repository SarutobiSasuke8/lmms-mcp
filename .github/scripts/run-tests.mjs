// Run unit tests by listing files, so `npm test` works on Node 20 as well as 22.
// `node --test` only expands glob arguments from Node 21 onwards.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tools = readdirSync(path.join(root, 'tools'))
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => path.join('tools', name));
const child = spawn(process.execPath, ['--test', 'test.mjs', ...tools], { stdio: 'inherit', cwd: root });
child.on('exit', code => process.exit(code ?? 1));
