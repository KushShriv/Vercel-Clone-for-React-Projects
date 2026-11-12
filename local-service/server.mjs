import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobStore } from './jobs.mjs';
import { checkRequest } from './security.mjs';
import { parseRepositoryUrl } from './repository.mjs';
import { validateArtifacts } from './artifacts.mjs';

const dashboardDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
const active = state => ['queued', 'cloning', 'building'].includes(state);
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
function send(res, status, data, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...(data === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...headers });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}
function listen(server, port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); }); }); }
function closeServer(server) { return new Promise(resolve => server.close(resolve)); }
function handleAsync(handler) {
  return (req, res) => { Promise.resolve(handler(req, res)).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'Internal service error' });
    else res.destroy();
  }); };
}
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new Error('Request body too large'); chunks.push(chunk); }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Expected JSON');
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected JSON object');
  return result;
}
async function safeFile(root, relative, fallback = false) {
  if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => part === '..' || part === '.')) return null;
  let file = path.join(root, relative || 'index.html');
  try {
    let resolved = await realpath(file);
    const base = await realpath(root);
    if (!resolved.startsWith(base + path.sep)) return null;
    let info = await stat(resolved);
    if (info.isDirectory()) { resolved = await realpath(path.join(resolved, 'index.html')); if (!resolved.startsWith(base + path.sep)) return null; info = await stat(resolved); }
    if (!info.isFile()) return null;
    return { file: resolved, ext: path.extname(resolved).toLowerCase() };
  } catch {
    if (fallback && !path.extname(relative)) return safeFile(root, 'index.html');
    return null;
  }
}
async function serveFile(res, root, relative, isPreview) {
  const item = await safeFile(root, relative, isPreview);
  if (!item) return send(res, 404, { error: 'Not found' });
  try {
    const bytes = await readFile(item.file);
    const csp = isPreview ? "default-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" : "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    res.writeHead(200, { ...securityHeaders, 'Content-Type': mime[item.ext] || 'application/octet-stream', 'Content-Security-Policy': csp }); res.end(bytes);
  } catch { send(res, 404, { error: 'Not found' }); }
}
export function createRateLimiter(clock = Date.now) {
  const rate = new Map();
  return key => {
    const now = clock();
    const history = (rate.get(key) || []).filter(time => now - time < 60000);
    if (history.length >= 120) { rate.set(key, history); return false; }
    history.push(now); rate.set(key, history); return true;
  };
}
export async function startService({ port = 4317, previewPort = 4318, token = randomBytes(32).toString('hex'), pagesOrigins = ['https://kushshriv.github.io'], worker } = {}) {
  if (!worker) ({ runWorker: worker } = await import('./worker.mjs'));
  const root = await mkdtemp(path.join(tmpdir(), 'vercel-clone-'));
  const store = new JobStore(), controllers = new Map(), promises = new Map(), retained = [];
  let controlPort, sitePort, closed = false, exporting = false;
  const allowRequest = createRateLimiter();
  async function prune() {
    while (retained.length > 10 && retained[0] !== exporting) {
      const oldest = retained.shift();
      if (store.get(oldest) && !active(store.get(oldest).state)) { store.delete(oldest); await rm(path.join(root, oldest), { recursive: true, force: true }); }
    }
  }
  const preview = http.createServer(handleAsync(async (req, res) => {
    if (closed) return send(res, 503, { error: 'Service is shutting down' });
    if (req.headers.host !== `127.0.0.1:${sitePort}` || req.method !== 'GET') return send(res, 403, { error: 'Forbidden' });
    let raw; try { raw = decodeURIComponent((req.url || '').split('?')[0]); } catch { return send(res, 400, { error: 'Bad path' }); }
    const match = /^\/([0-9a-f]{32})\/(.*)$/.exec(raw);
    if (!match || store.get(match[1])?.state !== 'ready') return send(res, 404, { error: 'Not found' });
    return serveFile(res, path.join(root, match[1]), match[2], true);
  }));
  const control = http.createServer(handleAsync(async (req, res) => {
    if (closed) return send(res, 503, { error: 'Service is shutting down' });
    const host = `127.0.0.1:${controlPort}`;
    if (req.headers.host !== host) return send(res, 403, { error: 'Forbidden' });
    const rawPath = (req.url || '').split('?')[0];
    if (!rawPath.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
      let rel; try { rel = decodeURIComponent(rawPath.slice(1)); } catch { return send(res, 400, { error: 'Bad path' }); }
      return serveFile(res, dashboardDir, rel, false);
    }
    const origin = req.headers.origin;
    const origins = [`http://${host}`, ...pagesOrigins];
    const cors = origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const key = req.socket.remoteAddress || '';
    if (!allowRequest(key)) return send(res, 429, { error: 'Rate limit exceeded' }, cors);
    if (req.method === 'OPTIONS') {
      if (!origins.includes(origin)) return send(res, 403, { error: 'Forbidden' });
      return send(res, 204, undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}) });
    }
    const effectiveHeaders = !origin && req.headers['sec-fetch-site'] === 'same-origin'
      ? { ...req.headers, origin: `http://${host}` } : req.headers;
    if (!checkRequest(effectiveHeaders, { host, origins, token })) return send(res, 403, { error: 'Forbidden' });
    const reply = (code, data) => send(res, code, data, cors);
    if (req.method === 'GET' && rawPath === '/api/health') return reply(200, { ok: true });
    if (req.method === 'POST' && rawPath === '/api/jobs') {
      let input, repository;
      try {
        input = await body(req);
        if (input.confirmed !== true) throw new Error('Explicit confirmation is required');
        repository = parseRepositoryUrl(input.repository);
        if (typeof input.revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(input.revision) || input.revision.includes('..') || input.revision.endsWith('/') || input.revision.endsWith('.lock')) throw new Error('Invalid revision');
      } catch (error) { return reply(400, { error: error.message }); }
      if (closed) return reply(503, { error: 'Service is shutting down' });
      let job; try { job = store.create(repository); } catch (error) { return reply(409, { error: error.message }); }
      const outputDir = path.join(root, job.id);
      try { await mkdir(outputDir); } catch { store.transition(job.id, 'failed'); store.delete(job.id); return reply(500, { error: 'Could not create job storage' }); }
      if (closed) { store.transition(job.id, 'cancelled'); await rm(outputDir, { recursive: true, force: true }); return reply(503, { error: 'Service is shutting down' }); }
      const controller = new AbortController(); controllers.set(job.id, controller);
      const run = (async () => {
        try {
          await worker({ repository, revision: input.revision, outputDir, basePath: `/${job.id}/`, signal: controller.signal, onState: state => store.transition(job.id, state), onLog: text => store.appendLog(job.id, String(text)), onCommit: sha => store.setCommit(job.id, sha) });
          if (controller.signal.aborted) throw new Error('Cancelled');
          await validateArtifacts(outputDir, { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 });
          if (controller.signal.aborted) throw new Error('Cancelled');
          store.transition(job.id, 'ready');
        } catch (error) {
          const state = store.get(job.id)?.state;
          if (active(state)) { store.appendLog(job.id, `\n${controller.signal.aborted ? 'Cancelled' : String(error.message || error)}\n`); store.transition(job.id, controller.signal.aborted ? 'cancelled' : 'failed'); }
          await rm(outputDir, { recursive: true, force: true });
        } finally {
          controllers.delete(job.id); promises.delete(job.id); retained.push(job.id);
          await prune();
        }
      })();
      promises.set(job.id, run);
      return reply(202, { ...store.get(job.id), previewUrl: null });
    }
    const match = /^\/api\/jobs\/([0-9a-f]{32})(\/cancel|\/artifact)?$/.exec(rawPath);
    if (!match) return reply(404, { error: 'Not found' });
    const [, id, cancel] = match, job = store.get(id);
    if (!job) return reply(404, { error: 'Not found' });
    if (req.method === 'GET' && cancel === '/artifact') {
      if (job.state !== 'ready') return reply(409, { error: 'Job is not ready' });
      if (exporting) return reply(409, { error: 'Another artifact export is in progress' });
      exporting = id;
      try {
        const output = path.join(root, id);
        await validateArtifacts(output, { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 });
        const files = []; let bytes = 0;
        async function visit(relative = '') {
          for (const entry of await readdir(path.join(output, relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) await visit(name);
            else if (entry.isFile()) { const content = await readFile(path.join(output, name)); bytes += content.length; if (bytes > 50 * 1024 * 1024 || files.length >= 5000) throw new Error('Artifact exceeds export limit'); files.push({ path: name, content: content.toString('base64') }); }
            else throw new Error('Unsafe artifact entry');
          }
        }
        await visit();
        return reply(200, { id, files });
      } finally { exporting = false; await prune(); }
    }
    if (req.method === 'GET' && !cancel) return reply(200, { ...job, previewUrl: job.state === 'ready' ? `http://127.0.0.1:${sitePort}/${id}/` : null });
    if (req.method === 'POST' && cancel === '/cancel') { if (!active(job.state)) return reply(409, { error: 'Job is not active' }); controllers.get(id)?.abort(); return reply(202, { ok: true }); }
    if (req.method === 'DELETE' && !cancel) { if (active(job.state)) return reply(409, { error: 'Cancel the active job first' }); if (exporting === id) return reply(409, { error: 'Artifact export is in progress' }); store.delete(id); await rm(path.join(root, id), { recursive: true, force: true }); return reply(204); }
    return reply(404, { error: 'Not found' });
  }));
  for (const server of [control, preview]) { server.headersTimeout = 10000; server.requestTimeout = 30000; server.maxConnections = 32; }
  try { sitePort = await listen(preview, previewPort); controlPort = await listen(control, port); }
  catch (error) { if (preview.listening) await closeServer(preview); await rm(root, { recursive: true, force: true }); throw error; }
  return { port: controlPort, previewPort: sitePort, token, async close() { if (closed) return; closed = true; for (const controller of controllers.values()) controller.abort(); await Promise.allSettled([...promises.values()]); await Promise.all([closeServer(control), closeServer(preview)]); await rm(root, { recursive: true, force: true }); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const service = await startService();
    console.log(`Dashboard: http://127.0.0.1:${service.port}/\nPairing token: ${service.token}\nPress Ctrl+C to stop and remove temporary jobs.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
  } catch (error) { console.error(`Could not start local service: ${error.message}`); process.exitCode = 1; }
}
