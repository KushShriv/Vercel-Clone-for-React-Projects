import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from '../security.mjs';

const config = { host: '127.0.0.1:4317', origins: ['http://127.0.0.1:4317'], token: 'test-secret' };
const valid = { host: config.host, origin: config.origins[0], authorization: 'Bearer test-secret' };

test('accepts only the configured loopback host, origin and bearer token', () => {
  assert.equal(checkRequest(valid, config), true);
  assert.equal(checkRequest({ ...valid, host: 'attacker.example:4317' }, config), false);
  assert.equal(checkRequest({ ...valid, origin: 'https://attacker.example' }, config), false);
  assert.equal(checkRequest({ ...valid, authorization: 'Bearer wrong' }, config), false);
  assert.equal(checkRequest({ ...valid, authorization: undefined }, config), false);
  assert.equal(checkRequest({ ...valid, origin: undefined }, config), false);
});
