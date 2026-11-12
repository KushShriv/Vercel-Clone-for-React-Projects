import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, validateDeploymentId } from '../publish.mjs';

test('accepts only opaque deployment prefixes', () => {
  assert.equal(validateDeploymentId('a'.repeat(32)), 'a'.repeat(32));
  for (const id of ['../other', 'A'.repeat(32), 'x'.repeat(32), 'a'.repeat(31)]) assert.throws(() => validateDeploymentId(id));
});

test('publishes and verifies each file before returning the public URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-test-'));
  const calls = [];
  try {
    await writeFile(join(root, 'index.html'), `<script src="/${'a'.repeat(32)}/app.js"></script>`);
    await writeFile(join(root, 'app.js'), 'console.log(1)');
    const run = async args => {
      calls.push(args);
      if (args[0] === 'cloudfront') return JSON.stringify({ Distribution: { Status: 'Deployed', DomainName: 'd123.cloudfront.net', DistributionConfig: { Enabled: true, Origins: { Items: [{ Id: 'origin', DomainName: 'example-bucket.s3.us-east-1.amazonaws.com', OriginAccessControlId: 'oac', OriginPath: '/deployments' }] }, DefaultCacheBehavior: { TargetOriginId: 'origin' } } } });
      if (args[1] === 'head-object') return JSON.stringify({ ChecksumSHA256: checksums.get(args[args.indexOf('--key') + 1]) });
      if (args[1] === 'put-object') { checksums.set(args[args.indexOf('--key') + 1], args[args.indexOf('--checksum-sha256') + 1]); return '{}'; }
      throw new Error('unexpected call');
    };
    const checksums = new Map();
    const url = await publish({ root, id: 'a'.repeat(32), bucket: 'example-bucket', distribution: 'E123', run, verifyPublic: async () => true });
    assert.equal(url, `https://d123.cloudfront.net/${'a'.repeat(32)}/`);
    assert.equal(calls.filter(args => args[1] === 'head-object').length, 2);
    assert.equal(calls.filter(args => args[1] === 'put-object').length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not report a URL when an upload fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-test-'));
  try {
    await writeFile(join(root, 'index.html'), `<script src="/${'b'.repeat(32)}/app.js"></script>`);
    let checked = false;
    await assert.rejects(publish({ root, id: 'b'.repeat(32), bucket: 'example-bucket', distribution: 'E123', run: async args => {
      if (args[0] === 'cloudfront') return JSON.stringify({ Distribution: { Status: 'Deployed', DomainName: 'd123.cloudfront.net', DistributionConfig: { Enabled: true, Origins: { Items: [{ Id: 'origin', DomainName: 'example-bucket.s3.us-east-1.amazonaws.com', OriginAccessControlId: 'oac', OriginPath: '/deployments' }] }, DefaultCacheBehavior: { TargetOriginId: 'origin' } } } });
      if (args[1] === 'put-object' && args.includes('--if-none-match')) return '{}';
      throw new Error('upload failed');
    }, verifyPublic: async () => { checked = true; } }), /upload failed/);
    assert.equal(checked, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delete targets only the exact deployment prefix and waits for invalidation', async () => {
  const { deleteDeployment } = await import('../publish.mjs');
  const calls = [];
  const run = async args => { calls.push(args); if (args[1] === 'create-invalidation') return JSON.stringify({ Invalidation: { Id: 'I123' } }); return '{}'; };
  await deleteDeployment({ id: 'c'.repeat(32), bucket: 'example-bucket', distribution: 'E123', run });
  assert.deepEqual(calls[0].slice(0, 4), ['s3', 'rm', `s3://example-bucket/deployments/${'c'.repeat(32)}/`, '--recursive']);
  assert.equal(calls[1][1], 'create-invalidation');
  assert.equal(calls[2][1], 'wait');
  await assert.rejects(deleteDeployment({ id: '../wrong', bucket: 'example-bucket', distribution: 'E123', run }));
});

test('artifact import refuses a path that escapes its temporary directory', async () => {
  const { exportJob } = await import('../publish.mjs');
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'd'.repeat(32), files: [{ path: '../outside', content: 'eA==' }] }), { status: 200 });
  await assert.rejects(exportJob({ id: 'd'.repeat(32), token: 'token', fetchImpl }), /path/i);
});

test('artifact import uses bearer authentication and preserves verified files', async () => {
  const { exportJob } = await import('../publish.mjs');
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer secret');
    return new Response(JSON.stringify({ id: 'd'.repeat(32), files: [{ path: 'index.html', content: Buffer.from('ok').toString('base64') }] }), { status: 200 });
  };
  const root = await exportJob({ id: 'd'.repeat(32), token: 'secret', fetchImpl });
  try { assert.equal((await import('node:fs/promises')).readFile && await (await import('node:fs/promises')).readFile(join(root, 'index.html'), 'utf8'), 'ok'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a distribution whose origin only resembles the requested S3 bucket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publish-test-'));
  try {
    const id = 'e'.repeat(32);
    await writeFile(join(root, 'index.html'), `<script src="/${id}/app.js"></script>`);
    await assert.rejects(publish({ root, id, bucket: 'example-bucket', distribution: 'E123', run: async () => JSON.stringify({ Distribution: { Status: 'Deployed', DomainName: 'd123.cloudfront.net', DistributionConfig: { Enabled: true, Origins: { Items: [{ Id: 'origin', DomainName: 'example-bucket.s3.evil.example', OriginPath: '/deployments', OriginAccessControlId: 'oac' }] }, DefaultCacheBehavior: { TargetOriginId: 'origin' } } } }) }), /expected private S3 origin/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects artifact exports with too many files', async () => {
  const { exportJob } = await import('../publish.mjs');
  const id = 'd'.repeat(32);
  const fetchImpl = async () => new Response(JSON.stringify({ id, files: Array.from({ length: 5001 }, () => ({ path: 'x', content: '' })) }), { status: 200 });
  await assert.rejects(exportJob({ id, token: 'secret', fetchImpl }), /Invalid artifact/);
});
