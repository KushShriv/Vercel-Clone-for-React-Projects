import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepositoryUrl } from './repository.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const image = 'vercel-clone-local-worker:v1';
export function validateRevision(revision = 'HEAD') {
  if (typeof revision !== 'string' || revision.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(revision) || revision.includes('..') || revision.includes('//') || revision.endsWith('/') || revision.endsWith('.') || revision.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid revision');
  return revision;
}
export function validateBasePath(value = '/') {
  if (value !== '/' && !/^\/[a-f0-9]{32}\/$/.test(value)) throw new Error('Invalid preview base path');
  return value;
}
export function workerContainerArgs(name, imageName, network = 'none') {
  return ['run', '-d', '--name', name, `--network=${network}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=1', '--user=1000:1000', '--tmpfs', '/work:rw,exec,nosuid,size=1g,uid=1000,gid=1000,mode=0700', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m,uid=1000,gid=1000', '--workdir=/work', imageName, 'sleep', 'infinity'];
}
function command(args, { signal, onLog = () => {}, quiet = false, timeout = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Build cancelled'));
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => {
      const text = chunk.toString();
      output = (output + text).slice(-65536);
      if (!quiet) onLog(text);
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let reason;
    const abort = () => { reason = 'Build cancelled'; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { reason = 'Worker command timed out'; child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reason) reject(new Error(reason));
      else if (code !== 0) reject(new Error(`Docker command failed (${code}): ${output.slice(-1500)}`));
      else resolve(output.trim());
    });
  });
}


const maxOutputBytes = 64 * 1024 * 1024;
const maxArchiveBytes = 80 * 1024 * 1024;
function tarString(buffer) {
  const end = buffer.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? buffer : buffer.subarray(0, end));
}
function tarNumber(buffer) {
  const value = tarString(buffer).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Invalid tar number');
  const result = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(result)) throw new Error('Invalid tar number');
  return result;
}
function paxPath(data) {
  let offset = 0, path;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid tar metadata');
    const digits = data.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error('Invalid tar metadata');
    const length = Number(digits), end = offset + length;
    if (end > data.length || end <= space + 1 || data[end - 1] !== 10) throw new Error('Invalid tar metadata');
    const record = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (equals < 1 || !['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) throw new Error('Unsupported tar metadata');
    if (key === 'path') { if (path !== undefined) throw new Error('Duplicate tar path'); path = value; }
    offset = end;
  }
  return path;
}
function safeTarName(raw) {
  if (raw.startsWith('/') || raw.includes('\\') || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Unsafe tar path');
  let name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (name === '.') name = '';
  if (name && name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe tar path');
  if (Buffer.byteLength(name) > 4096) throw new Error('Tar path too long');
  return name;
}
// Parse and validate the entire bounded Docker archive before writing any files.
export async function extractSafeTar(tar, outputDir, { maxBytes = maxOutputBytes, maxFiles = 10000, maxEntries = 12000, maxPathBytes = 8 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(tar) || tar.length > maxArchiveBytes) throw new Error('Output archive exceeds limit');
  const root = await lstat(outputDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid output directory');
  const entries = [], seen = new Set(), directories = new Set();
  let offset = 0, bytes = 0, files = 0, pathBytes = 0, pendingPath, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const expected = tarNumber(header.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== expected) throw new Error('Invalid tar checksum');
    const size = tarNumber(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48);
    const end = offset + size, next = offset + Math.ceil(size / 512) * 512;
    if (end > tar.length || next > tar.length) throw new Error('Truncated tar');
    const content = tar.subarray(offset, end); offset = next;
    if (type === 'x') {
      if (pendingPath !== undefined || size > 16384) throw new Error('Invalid tar metadata');
      pendingPath = paxPath(content) ?? null;
      continue;
    }
    const prefix = tarString(header.subarray(345, 500));
    const headerName = tarString(header.subarray(0, 100));
    const name = safeTarName(pendingPath || (prefix ? `${prefix}/${headerName}` : headerName));
    pendingPath = undefined;
    if (type !== '0' && type !== '5') throw new Error('Unsupported tar entry (links and special files are forbidden)');
    if (type === '5' && size !== 0) throw new Error('Invalid directory entry');
    if (!name) { if (type !== '5') throw new Error('Invalid tar root'); continue; }
    if (seen.has(name)) throw new Error('Duplicate tar entry');
    seen.add(name);
    pathBytes += Buffer.byteLength(name);
    const parts = name.split('/');
    if (parts.length > 32) throw new Error('Output path depth limit exceeded');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    if (type === '5') directories.add(name);
    if (seen.size > maxEntries || directories.size + files > maxEntries || pathBytes > maxPathBytes) throw new Error('Output entry count or path limit exceeded');
    if (type === '0') { bytes += size; files++; if (bytes > maxBytes || files > maxFiles || directories.size + files > maxEntries) throw new Error('Output size or file count limit exceeded'); }
    entries.push({ name, type, content });
  }
  if (!ended || pendingPath !== undefined) throw new Error('Incomplete tar');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    const name = parts.pop();
    let directory = outputDir;
    for (const part of [...parts, ...(entry.type === '5' ? [name] : [])]) {
      directory = join(directory, part);
      await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe output directory');
    }
    if (entry.type === '0') {
      const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { await file.writeFile(entry.content); } finally { await file.close(); }
    }
  }
}
function copyArchive(container, { signal, timeout = 900000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Build cancelled'));
    const child = spawn('docker', ['exec', container, '/bin/tar', '--format=posix', '-cf', '-', '-C', '/work/repo/dist', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, errorText = '', failure;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxArchiveBytes) { failure = 'Output archive exceeds size limit'; child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-2000); });
    const abort = () => { failure = 'Build cancelled'; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure = 'Output copy timed out'; child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure || code !== 0) reject(new Error(failure || `Output copy failed: ${errorText}`)); else resolve(Buffer.concat(chunks)); });
  });
}

// All untrusted code runs inside a bounded container. Dependency installation has
// only an internal network and a CONNECT proxy restricted to GitHub and npm.
// Project scripts run after that network has been disconnected.
export async function runWorker({ repository, revision = 'HEAD', outputDir, basePath = '/', signal, onState = () => {}, onLog = () => {}, onCommit = () => {} }) {
  const url = parseRepositoryUrl(repository);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000);
  revision = validateRevision(revision || 'HEAD');
  basePath = validateBasePath(basePath);
  if (!outputDir) throw new Error('Missing output directory');
  const suffix = randomBytes(12).toString('hex');
  const network = `vc-net-${suffix}`, worker = `vc-build-${suffix}`, proxy = `vc-proxy-${suffix}`;
  const context = await mkdtemp(join(tmpdir(), 'vc-worker-'));
  const run = (args, options = {}) => command(args, { signal, onLog, ...options });
  let networkAttempted = false, proxyAttempted = false, workerAttempted = false, workError;
  try {
    await Promise.all(['worker.Dockerfile', 'worker-proxy.mjs', 'worker-validate.cjs'].map(f => cp(join(here, f), join(context, f))));
    onLog('Preparing the isolated worker image.\n');
    await run(['build', '-t', image, '-f', join(context, 'worker.Dockerfile'), context]);
    networkAttempted = true;
    await run(['network', 'create', '--internal', network], { quiet: true });
    proxyAttempted = true;
    await run(['run', '-d', '--name', proxy, `--network=${network}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--cpus=0.25', '--user=1000:1000', image, 'node', '/opt/vercel-clone/worker-proxy.mjs'], { quiet: true });
    await run(['network', 'connect', 'bridge', proxy], { quiet: true });
    await run(['exec', proxy, 'node', '-e', "const net=require('node:net');let tries=0;function check(){const s=net.connect(3128,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>{s.destroy();if(++tries>=100)process.exit(1);setTimeout(check,100)})}check()"], { quiet: true });
    workerAttempted = true;
    await run(workerContainerArgs(worker, image, network), { quiet: true });
    const proxyEnv = ['-e', `HTTPS_PROXY=http://${proxy}:3128`, '-e', `HTTP_PROXY=http://${proxy}:3128`, '-e', 'NO_PROXY=', '-e', 'HOME=/work', '-e', 'GIT_TERMINAL_PROMPT=0', '-e', 'GIT_CONFIG_NOSYSTEM=1'];
    onState('cloning');
    await run(['exec', ...proxyEnv, worker, 'git', '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', 'clone', '--no-checkout', '--', url, '/work/repo']);
    let ref = revision;
    if (revision !== 'HEAD' && !/^[a-f0-9]{40}$/i.test(revision) && !revision.startsWith('refs/')) ref = `refs/remotes/origin/${revision}`;
    const sha = await run(['exec', worker, 'git', '-C', '/work/repo', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { quiet: true });
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Could not resolve revision to a commit');
    await run(['exec', worker, 'git', '-C', '/work/repo', 'checkout', '--detach', sha]);
    onCommit(sha);
    await run(['exec', '--workdir=/work/repo', worker, 'node', '/opt/vercel-clone/worker-validate.cjs']);
    onLog('Installing locked dependencies without lifecycle scripts.\n');
    await run(['exec', '--workdir=/work/repo', ...proxyEnv, '-e', 'npm_config_registry=https://registry.npmjs.org/', '-e', 'npm_config_userconfig=/dev/null', '-e', 'npm_config_cache=/work/.npm', '-e', 'CI=true', worker, 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    await run(['network', 'disconnect', network, worker], { quiet: true });
    const networks = await run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', worker], { quiet: true });
    if (Object.keys(JSON.parse(networks)).length !== 0) throw new Error('Unable to disconnect build network');
    onState('building');
    await run(['exec', '--workdir=/work/repo', '-e', 'HOME=/work', '-e', 'npm_config_cache=/work/.npm', '-e', 'CI=true', worker, 'npm', 'run', 'build', '--', '--base', basePath]);
    // Docker cannot copy a tmpfs after stopping it. Stream a bounded archive
    // inside the container, stop all its processes, then validate and extract.
    const archive = await copyArchive(worker, { signal });
    await run(['stop', '--time=1', worker], { quiet: true });
    await extractSafeTar(archive, outputDir);
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    // Cleanup must still run when the request has been cancelled.
    const failures = [];
    const cleanup = [];
    if (workerAttempted) cleanup.push(['rm', '-f', worker]);
    if (proxyAttempted) cleanup.push(['rm', '-f', proxy]);
    if (networkAttempted) cleanup.push(['network', 'rm', network]);
    for (const args of cleanup) {
      try { await command(args, { quiet: true, timeout: 15000 }); }
      catch (error) { if (!/No such (container|network)|is not paused/i.test(error.message)) failures.push(error.message); }
    }
    try { await rm(context, { recursive: true, force: true }); } catch (error) { failures.push(error.message); }
    if (failures.length) {
      const detail = `Cleanup failed: ${failures.join('; ')}`;
      onLog(`${detail}\n`);
      if (workError) workError.message += `; ${detail}`;
      else throw new Error(detail);
    }
  }
}
