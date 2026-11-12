import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../jobs.mjs';

test('enforces one active job and valid terminal transitions', () => {
  const jobs = new JobStore();
  const job = jobs.create('https://github.com/a/b');
  assert.match(job.id, /^[0-9a-f]{32}$/);
  assert.equal(job.state, 'queued');
  assert.throws(() => jobs.create('https://github.com/a/c'), /active/i);
  jobs.transition(job.id, 'cloning');
  jobs.transition(job.id, 'building');
  assert.throws(() => jobs.transition(job.id, 'ready'), /commit/i);
  jobs.setCommit(job.id, 'a'.repeat(40));
  jobs.transition(job.id, 'ready');
  assert.throws(() => jobs.transition(job.id, 'building'), /transition/i);
  assert.notEqual(jobs.create('https://github.com/a/c').id, job.id);
});

test('bounds retained log text and supports deleting terminal jobs', () => {
  const jobs = new JobStore({ maxLogBytes: 8 });
  const job = jobs.create('https://github.com/a/b');
  jobs.appendLog(job.id, '1234567890');
  assert.equal(jobs.get(job.id).logs, '34567890');
  assert.throws(() => jobs.delete(job.id), /active/i);
  jobs.transition(job.id, 'cancelled');
  jobs.delete(job.id);
  assert.equal(jobs.get(job.id), undefined);
});

test('log limit remains a byte limit for multibyte text', () => {
  const jobs = new JobStore({ maxLogBytes: 4 });
  const job = jobs.create('https://github.com/a/b');
  jobs.appendLog(job.id, '€€');
  assert.ok(Buffer.byteLength(jobs.get(job.id).logs) <= 4);
  assert.equal(jobs.get(job.id).logs, '€');
});
