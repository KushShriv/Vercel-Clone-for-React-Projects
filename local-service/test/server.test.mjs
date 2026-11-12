import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { startService, createRateLimiter } from '../server.mjs';

async function fixture(t) {
  let builds = 0;
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async ({ outputDir, onState, onCommit }) => {
    builds++; onState('cloning'); onCommit('a'.repeat(40)); onState('building');
    await writeFile(`${outputDir}/index.html`, '<h1>built</h1>');
  }});
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { Origin: origin, Authorization: 'Bearer test-token', ...options.headers } });
  return { service, origin, request, builds: () => builds };
}

test('API checks origin and token and requires explicit confirmation', async t => {
  const { origin, request, builds } = await fixture(t);
  assert.equal((await fetch(origin + '/api/health')).status, 403);
  assert.equal((await request('/api/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/health')).status, 200);
  const response = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b' }) });
  assert.equal(response.status, 400);
  assert.equal(builds(), 0);
});

test('build reports ready only after output validates and serves on separate origin', async t => {
  const { service, request } = await fixture(t);
  const response = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  let job;
  for (let i = 0; i < 50; i++) {
    job = await (await request(`/api/jobs/${id}`)).json();
    if (job.state === 'ready' || job.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.state, 'ready');
  assert.equal(job.commit, 'a'.repeat(40));
  assert.equal(job.previewUrl, `http://127.0.0.1:${service.previewPort}/${id}/`);
  const preview = await fetch(job.previewUrl);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /built/);
  const exported = await (await request(`/api/jobs/${id}/artifact`)).json();
  assert.equal(exported.id, id);
  assert.equal(Buffer.from(exported.files[0].content, 'base64').toString(), '<h1>built</h1>');
  assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/jobs/${id}/artifact`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${service.previewPort}/${id}/%2e%2e/secret`)).status, 404);
  assert.equal((await request(`/api/jobs/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(job.previewUrl)).status, 404);
});

test('same-origin browser GET without Origin header can use a valid pairing token', async t => {
  const { origin } = await fixture(t);
  const response = await fetch(origin + '/api/health', { headers: { Authorization: 'Bearer test-token', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200);
});

test('failed and cancelled workers never become ready', async t => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async ({ signal, onState }) => {
    onState('cloning'); started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('cancelled');
  }});
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const req = (path, options = {}) => fetch(origin + path, { ...options, headers: { Origin: origin, Authorization: 'Bearer test-token', ...options.headers } });
  const response = await req('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true }) });
  const { id } = await response.json(); await startedPromise;
  assert.equal((await req(`/api/jobs/${id}/cancel`, { method: 'POST' })).status, 202);
  let job;
  for (let i = 0; i < 50; i++) { job = await (await req(`/api/jobs/${id}`)).json(); if (job.state === 'cancelled') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.state, 'cancelled');
  assert.equal(job.previewUrl, null);
});

test('rejects untrusted Host and a build without valid output', async t => {
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async ({ onState, onCommit }) => {
    onState('cloning'); onCommit('a'.repeat(40)); onState('building');
  }});
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const headers = { Origin: origin, Authorization: 'Bearer test-token' };
  const badHostStatus = await new Promise((resolve, reject) => { const req = http.get(`${origin}/api/health`, { headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(badHostStatus, 403);
  const response = await fetch(origin + '/api/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true }) });
  const { id } = await response.json();
  let job;
  for (let i = 0; i < 50; i++) { job = await (await fetch(`${origin}/api/jobs/${id}`, { headers })).json(); if (job.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.state, 'failed');
  assert.match(job.logs, /index.html/);
  assert.equal(job.previewUrl, null);
});

test('allows loopback permission preflight only from an approved Pages origin', async t => {
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: ['https://example.github.io'], worker: async () => {} });
  t.after(() => service.close());
  const endpoint = `http://127.0.0.1:${service.port}/api/health`;
  const response = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  const forbidden = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('access-control-allow-private-network'), null);
});

test('limits repeated requests on loopback', async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/health')).status, 429);
  assert.equal((await request('/api/health')).status, 429);
});


test('blocked requests do not extend the rate limit window', () => {
  let now = 0;
  const allow = createRateLimiter(() => now);
  for (let i = 0; i < 120; i++) assert.equal(allow('client'), true);
  now = 59999;
  for (let i = 0; i < 200; i++) assert.equal(allow('client'), false);
  now = 60000;
  assert.equal(allow('client'), true);
});

test('service refuses new work while a cancelled worker is shutting down', async t => {
  let started, finish;
  const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async ({ signal, onState }) => { onState('cloning'); started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); await wait; throw new Error('Stopped'); } });
  const origin = `http://127.0.0.1:${service.port}`;
  const req = (path, options = {}) => fetch(origin + path, { ...options, headers: { Origin: origin, Authorization: 'Bearer test-token', ...options.headers } });
  await req('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true }) });
  await start;
  const closing = service.close();
  try { assert.equal((await req('/api/health')).status, 503); }
  finally { finish(); await closing; }
});

test('a request already uploading cannot create a job after shutdown begins', async () => {
  let builds = 0;
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async () => { builds++; } });
  const origin = `http://127.0.0.1:${service.port}`;
  const payload = JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true });
  let finishRequest;
  const result = new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/jobs`, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.flushHeaders(); finishRequest = () => req.end(payload);
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const closing = service.close();
  finishRequest();
  try { assert.equal(await result, 503); assert.equal(builds, 0); } finally { await closing; }
});

test('deletion does not remove an artifact during export', async t => {
  const service = await startService({ port: 0, previewPort: 0, token: 'test-token', pagesOrigins: [], worker: async ({ outputDir, onState, onCommit }) => {
    onState('cloning'); onCommit('a'.repeat(40)); onState('building');
    await writeFile(`${outputDir}/index.html`, 'ok');
    await Promise.all(Array.from({ length: 400 }, (_, i) => writeFile(`${outputDir}/${i}.txt`, 'x')));
  }});
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const req = (path, options = {}) => fetch(origin + path, { ...options, headers: { Origin: origin, Authorization: 'Bearer test-token', ...options.headers } });
  const response = await req('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'https://github.com/a/b', revision: 'main', confirmed: true }) });
  const { id } = await response.json();
  for (;;) { const job = await (await req(`/api/jobs/${id}`)).json(); if (job.state === 'ready') break; assert.notEqual(job.state, 'failed'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const exporting = req(`/api/jobs/${id}/artifact`);
  await new Promise(resolve => setTimeout(resolve, 5));
  const deletion = await req(`/api/jobs/${id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 409);
  assert.equal((await exporting).status, 200);
  assert.equal((await req(`/api/jobs/${id}`, { method: 'DELETE' })).status, 204);
});
