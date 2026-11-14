// Starts the server over stdio without LMMS and checks that it lists its tools.
// Catches start-up failures such as a tools/ module that throws on load.
// Run: node .github/scripts/smoke-server.mjs [--server path/to/server.mjs] [--out schemas.json]
// --out writes every tool's name, description and input schema, for diff-schemas.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: { server: { type: 'string' }, out: { type: 'string' } } });
const server = path.resolve(values.server ?? fileURLToPath(new URL('../../server.mjs', import.meta.url)));
const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-smoke-'));
const client = new Client({ name: 'lmms-smoke', version: '1' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: path.dirname(server),
    env: { ...process.env, LMMS_WORKSPACE: workspace },
    stderr: 'inherit',
  }));
  const tools = (await client.listTools()).tools;
  assert.ok(tools.length > 0, 'server listed no tools');
  const names = new Set(tools.map(tool => tool.name));
  assert.equal(names.size, tools.length, 'duplicate tool names');
  for (const tool of tools) assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has no object input schema`);
  if (values.out) {
    const schemas = Object.fromEntries(tools.map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema }]));
    await writeFile(values.out, JSON.stringify(schemas, null, 2) + '\n');
  } else {
    const result = await client.callTool({ name: 'get_started', arguments: {} });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const start = JSON.parse(result.content[0].text);
    const missing = Object.values(start.workflows ?? {}).flat().filter(name => !names.has(name));
    assert.deepEqual(missing, [], 'get_started names tools that do not exist');
  }
  console.log(`Server started and listed ${tools.length} tools`);
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}
