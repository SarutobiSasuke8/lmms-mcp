#!/usr/bin/env node
// Serve the sound library page and every sample it lists from one local address, so the page can play them.
// Usage: node library-server.mjs [port]
// Reads LMMS_WORKSPACE, LMMS_SAMPLE_LIBRARIES and LMMS_SAMPLES (or the default LMMS install). Listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const types = { '.html': 'text/html; charset=utf-8', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };
const defaultSamples = process.platform === 'win32' ? 'C:/Program Files/LMMS/data/samples' : '/usr/share/lmms/samples';
export function mounts(env = process.env) {
  return {
    workspace: path.resolve(env.LMMS_WORKSPACE ?? path.join(os.homedir(), 'Music', 'LMMS MCP')),
    stock: path.resolve(env.LMMS_SAMPLES ?? defaultSamples),
    // Falls back to where setup-libraries-windows.ps1 puts them.
    library: env.LMMS_SAMPLE_LIBRARIES ? path.resolve(env.LMMS_SAMPLE_LIBRARIES)
      : env.LOCALAPPDATA && existsSync(path.join(env.LOCALAPPDATA, 'lmms-mcp', 'libraries')) ? path.join(env.LOCALAPPDATA, 'lmms-mcp', 'libraries') : null,
  };
}
// Map a request path to a file inside one of the three folders, or null. /_stock/ and /_lib/ are the two mounts; anything else is the workspace.
export function resolveRequest(urlPath, folders) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const pick = decoded.startsWith('/_stock/') ? [folders.stock, decoded.slice(8)] : decoded.startsWith('/_lib/') ? [folders.library, decoded.slice(6)] : [folders.workspace, decoded.slice(1)];
  const [base, relative] = pick;
  if (!base) return null;
  const full = path.resolve(base, relative || 'sound-library.html');
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (path.basename(full).startsWith('.')) return null;
  return full;
}
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : size - Number(match[2]), end = match[1] && match[2] ? Number(match[2]) : size - 1;
  start = Math.max(0, start); end = Math.min(size - 1, end);
  return start <= end ? { start, end } : null;
}
export function startServer({ port = 18290, folders = mounts() } = {}) {
  const server = createServer(async (request, response) => {
    const file = request.method === 'GET' || request.method === 'HEAD' ? resolveRequest(request.url, folders) : null;
    const info = file && await stat(file).catch(() => null);
    if (!info?.isFile()) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not found'); return; }
    const headers = { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    const range = parseRange(request.headers.range, info.size);
    if (range) { headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`; headers['content-length'] = range.end - range.start + 1; response.writeHead(206, headers); }
    else { headers['content-length'] = info.size; response.writeHead(200, headers); }
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file, range ?? {}).on('error', () => response.destroy()).pipe(response);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 18290), folders = mounts();
  if (!existsSync(folders.workspace)) { console.error(`Workspace not found: ${folders.workspace}`); process.exit(1); }
  startServer({ port, folders });
  console.log(`Sound library at http://127.0.0.1:${port}/sound-library.html`);
  console.log(`workspace: ${folders.workspace}\nstock samples: ${folders.stock}\nlibraries: ${folders.library ?? '(LMMS_SAMPLE_LIBRARIES not set)'}`);
}
