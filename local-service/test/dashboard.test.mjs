import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  constructor() { this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.textContent = ''; this.listeners = {}; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  async dispatch(name) { await this.listeners[name]({ preventDefault() {} }); }
}
test('dashboard waits for pairing and explicit build confirmation', async () => {
  const ids = ['connect-form','build-form','token','repository','revision','confirm','build-button','cancel','delete','preview','connection-state','connect-message','build-message','job-state','job-description','job-id','commit','logs','job-message'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const calls = [];
  const fetch = async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => path === '/api/health' ? { ok: true } : { id: 'a'.repeat(32), state: 'queued', repository: 'https://github.com/a/b' } };
  };
  runInNewContext(await readFile('local-service/dashboard/app.js', 'utf8'), { window: { location: { origin: 'http://127.0.0.1:4317' } }, document: { getElementById: id => elements[id] }, fetch, URL, setTimeout: () => 1, clearTimeout() {} });
  assert.equal(calls.length, 0);
  elements.token.value = 'secret';
  await elements['connect-form'].dispatch('submit');
  assert.equal(calls[0].path, '/api/health');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(elements.token.value, '');
  elements.repository.value = 'https://github.com/a/b';
  await elements['build-form'].dispatch('submit');
  assert.equal(calls.length, 1);
  elements.confirm.checked = true;
  await elements['build-form'].dispatch('submit');
  assert.equal(calls[1].path, '/api/jobs');
  assert.equal(JSON.parse(calls[1].options.body).confirmed, true);
  assert.equal(elements['job-state'].textContent, 'queued');
  assert.equal(elements['job-id'].textContent, `Job ID: ${'a'.repeat(32)}`);
  await elements.delete.dispatch('click');
  assert.equal(elements['job-id'].hidden, true);
  assert.equal(elements['job-id'].textContent, '');
});

test('Pages mode only contacts loopback after explicit pairing', async () => {
  const ids = ['connect-form','build-form','token','repository','revision','confirm','build-button','cancel','delete','preview','connection-state','connect-message','build-message','job-state','job-description','job-id','commit','logs','job-message'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const calls = [];
  const fetch = async (path, options) => { calls.push({ path, options }); return { ok: true, json: async () => ({ ok: true }) }; };
  runInNewContext(await readFile('docs/local/app.js', 'utf8'), { window: { location: { origin: 'https://kushshriv.github.io' } }, document: { getElementById: id => elements[id] }, fetch, URL, setTimeout: () => 1, clearTimeout() {} });
  assert.equal(calls.length, 0);
  elements.token.value = 'secret';
  await elements['connect-form'].dispatch('submit');
  assert.equal(calls[0].path, 'http://127.0.0.1:4317/api/health');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});

test('Pages and local dashboard copies remain in sync', async () => {
  for (const file of ['index.html', 'style.css', 'app.js']) {
    assert.equal(await readFile(`docs/local/${file}`, 'utf8'), await readFile(`local-service/dashboard/${file}`, 'utf8'), `${file} differs`);
  }
});
