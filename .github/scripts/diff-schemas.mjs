// Compares two tool schema dumps from smoke-server.mjs --out and prints a Markdown report.
// Run: node .github/scripts/diff-schemas.mjs base.json head.json
// Breaking: a tool removed, an argument removed, a new required argument, or an argument's type changed.
import { readFile } from 'node:fs/promises';

const [base, head] = await Promise.all(process.argv.slice(2, 4).map(async file => JSON.parse(await readFile(file, 'utf8'))));
const breaking = [], other = [];
const props = schema => schema?.inputSchema?.properties ?? {};
const required = schema => new Set(schema?.inputSchema?.required ?? []);
const typeOf = prop => JSON.stringify(prop?.type ?? prop?.anyOf?.map(p => p.type) ?? prop?.enum ?? null);

for (const name of Object.keys(base)) if (!(name in head)) breaking.push(`\`${name}\`: tool removed`);
for (const name of Object.keys(head)) {
  if (!(name in base)) { other.push(`\`${name}\`: new tool`); continue; }
  const [was, now] = [base[name], head[name]];
  const [wasProps, nowProps, wasRequired, nowRequired] = [props(was), props(now), required(was), required(now)];
  for (const arg of Object.keys(wasProps)) if (!(arg in nowProps)) breaking.push(`\`${name}\`: argument \`${arg}\` removed`);
  for (const arg of Object.keys(nowProps)) {
    if (!(arg in wasProps)) (nowRequired.has(arg) ? breaking : other).push(`\`${name}\`: ${nowRequired.has(arg) ? 'new required' : 'new optional'} argument \`${arg}\``);
    else {
      if (typeOf(wasProps[arg]) !== typeOf(nowProps[arg])) breaking.push(`\`${name}\`: argument \`${arg}\` changed type from ${typeOf(wasProps[arg])} to ${typeOf(nowProps[arg])}`);
      else if (JSON.stringify(wasProps[arg]) !== JSON.stringify(nowProps[arg])) other.push(`\`${name}\`: argument \`${arg}\` schema changed`);
      if (!wasRequired.has(arg) && nowRequired.has(arg)) breaking.push(`\`${name}\`: argument \`${arg}\` is now required`);
    }
  }
  if (was.description !== now.description) other.push(`\`${name}\`: description changed`);
}

const lines = ['## Tool schema changes against the base branch', ''];
if (!breaking.length && !other.length) lines.push('No tool schema changes.');
if (breaking.length) lines.push('### Possibly breaking', '', ...breaking.map(line => `- ${line}`), '');
if (other.length) lines.push('### Other changes', '', ...other.map(line => `- ${line}`), '');
if (breaking.length) lines.push('Add these to the change log under the next version, and say what agents should do instead.');
console.log(lines.join('\n'));
