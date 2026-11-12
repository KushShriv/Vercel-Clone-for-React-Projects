import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerContainerArgs, validateRevision, validateBasePath } from '../worker.mjs';

test('worker container is non-root, bounded, isolated, and has no host mounts', () => {
  const args = workerContainerArgs('job', 'example-image');
  for (const option of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=1', '--user=1000:1000']) assert.ok(args.includes(option), option);
  assert.ok(args.some(a => a.startsWith('/work:rw,exec,')));
  assert.ok(!args.some(a => a === '-v' || a === '--volume' || a.startsWith('--mount')));
});

test('accepts safe revision names and rejects git options and control characters', () => {
  for (const value of ['HEAD', 'main', 'feature/test', 'a'.repeat(40)]) assert.equal(validateRevision(value), value);
  for (const value of ['--help', 'main;touch x', 'refs/../x', 'x\ny', '', 'x@{1}', 'x.lock', 'a//b']) assert.throws(() => validateRevision(value));
});

test('accepts only a root path or a single opaque job path for Vite base', () => {
  assert.equal(validateBasePath('/'), '/');
  assert.equal(validateBasePath('/' + 'a'.repeat(32) + '/'), '/' + 'a'.repeat(32) + '/');
  for (const value of ['//evil/', '/../', '/abc/', '/a?b/', 'https://evil/']) assert.throws(() => validateBasePath(value));
});

test('repository convention check rejects external package sources and linked inputs', async () => {
  const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'vc-convention-test-'));
  const validator = fileURLToPath(new URL('../worker-validate.cjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [validator], { cwd: dir, encoding: 'utf8' });
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '1', 'react-dom': '1', vite: '1' }, scripts: { build: 'vite build' } }));
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/x': { resolved: 'https://registry.npmjs.org/x/-/x-1.tgz' } } }));
    assert.equal(run().status, 0);
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { resolved: 'https://evil.invalid/x.tgz' } } }));
    assert.notEqual(run().status, 0);
    await rm(join(dir, 'package-lock.json'));
    await symlink('/etc/passwd', join(dir, 'package-lock.json'));
    assert.notEqual(run().status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('safe tar extraction accepts files and rejects symlinks before writing', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { extractSafeTar } = await import('../worker.mjs');
  const root = await mkdtemp(join(tmpdir(), 'vc-tar-test-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    await mkdir(source); await mkdir(target);
    await writeFile(join(source, 'index.html'), 'ok');
    let tar = spawnSync('tar', ['--format', 'ustar', '--no-xattrs', '-cf', '-', '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).stdout;
    await extractSafeTar(tar, target);
    assert.equal(await readFile(join(target, 'index.html'), 'utf8'), 'ok');
    await rm(target, { recursive: true }); await mkdir(target);
    await symlink('/etc/passwd', join(source, 'bad'));
    tar = spawnSync('tar', ['--format', 'ustar', '--no-xattrs', '-cf', '-', '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).stdout;
    await assert.rejects(extractSafeTar(tar, target), /unsupported|link/i);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe tar extraction limits directories as well as regular files', async () => {
  const { mkdtemp, mkdir, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { extractSafeTar } = await import('../worker.mjs');
  const root = await mkdtemp(join(tmpdir(), 'vc-tar-limit-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    await mkdir(source); await mkdir(target);
    for (const name of ['first', 'second', 'third']) await mkdir(join(source, name));
    const tar = spawnSync('tar', ['--format', 'ustar', '--no-xattrs', '-cf', '-', '-C', source, '.']).stdout;
    await assert.rejects(extractSafeTar(tar, target, { maxEntries: 2 }), /entry|entries/i);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe tar extraction rejects traversal, malformed archives and oversized output before writing', async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { extractSafeTar } = await import('../worker.mjs');
  const root = await mkdtemp(join(tmpdir(), 'vc-tar-traversal-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    await mkdir(source); await mkdir(target); await writeFile(join(source, 'index.html'), 'hello');
    const good = spawnSync('tar', ['--format', 'ustar', '--no-xattrs', '-cf', '-', '-C', source, 'index.html']).stdout;
    await assert.rejects(extractSafeTar(good, target, { maxBytes: 4 }), /size/i);
    const tampered = Buffer.from(good);
    tampered.fill(0, 0, 100); tampered.write('../escape', 0, 'utf8');
    tampered.fill(32, 148, 156);
    const sum = tampered.subarray(0, 512).reduce((n, byte) => n + byte, 0);
    tampered.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    await assert.rejects(extractSafeTar(tampered, target), /unsafe/i);
    await assert.rejects(extractSafeTar(good.subarray(0, 510), target), /incomplete/i);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
