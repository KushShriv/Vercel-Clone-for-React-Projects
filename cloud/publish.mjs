import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateArtifacts } from '../local-service/artifacts.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
export function validateDeploymentId(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Deployment ID must be 32 lowercase hexadecimal characters'); return id; }
function validateBucket(bucket) { if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) throw new Error('Invalid bucket'); return bucket; }
function validateDistribution(id) { if (!/^[A-Z0-9]{1,32}$/.test(id)) throw new Error('Invalid distribution ID'); return id; }
function aws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', [...args, '--output', 'json', '--no-cli-pager'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`AWS command failed (${code}): ${err}`)));
  });
}
const sha256 = data => createHash('sha256').update(data).digest('base64');
async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(dir, rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error('Only regular files and directories are allowed');
  }
  return files.sort();
}
async function publicCheck(url, expected) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 50 * 1024 * 1024) throw new Error(`Public URL verification failed: ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 50 * 1024 * 1024) throw new Error('Public output exceeds size limit'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expected) throw new Error('Public output checksum did not match');
  return true;
}
export async function publish({ root, id, bucket, distribution, run = aws, verifyPublic = publicCheck }) {
  validateDeploymentId(id); validateBucket(bucket); validateDistribution(distribution);
  await validateArtifacts(root, { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 });
  const index = await readFile(path.join(root, 'index.html'));
  if (!index.toString('utf8').includes(`/${id}/`)) throw new Error('Build must use this deployment ID as its Vite base path');
  const files = (await listFiles(root)).sort((a, b) => (a === 'index.html') - (b === 'index.html') || a.localeCompare(b));
  const data = [];
  for (const file of files) { const bytes = await readFile(path.join(root, file)); data.push({ file, checksum: sha256(bytes) }); }
  const description = JSON.parse(await run(['cloudfront', 'get-distribution', '--id', distribution]));
  const d = description.Distribution, origin = d?.DistributionConfig?.Origins?.Items?.find(o => o.Id === d.DistributionConfig.DefaultCacheBehavior?.TargetOriginId);
  const originPrefix = `${bucket}.s3.`;
  const regionSuffix = origin?.DomainName?.startsWith(originPrefix) ? origin.DomainName.slice(originPrefix.length) : '';
  if (d?.Status !== 'Deployed' || !d.DistributionConfig?.Enabled || !/^d[a-z0-9]+\.cloudfront\.net$/.test(d.DomainName || '') || !/^[a-z0-9-]+\.amazonaws\.com$/.test(regionSuffix) || !origin.OriginAccessControlId || origin.OriginPath !== '/deployments') throw new Error('Distribution is not deployed with the expected private S3 origin');
  const temp = await mkdtemp(path.join(tmpdir(), 'publish-marker-'));
  try {
    const marker = path.join(temp, 'reserved'); await writeFile(marker, '');
    const prefix = `deployments/${id}/`;
    await run(['s3api', 'put-object', '--bucket', bucket, '--key', `${prefix}.reserved`, '--body', marker, '--if-none-match', '*', '--checksum-sha256', sha256('')]);
    for (const { file, checksum } of data) {
      const key = prefix + file;
      await run(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', path.join(root, file), '--checksum-sha256', checksum, '--content-type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream', '--cache-control', 'public, max-age=31536000, immutable', '--if-none-match', '*']);
      const head = JSON.parse(await run(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--checksum-mode', 'ENABLED']));
      if (head.ChecksumSHA256 !== checksum) throw new Error(`S3 checksum verification failed for ${file}`);
    }
    const url = `https://${d.DomainName}/${id}/`;
    if (!await verifyPublic(url, sha256(index))) throw new Error('Public URL verification failed');
    return url;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function exportJob({ id, token, fetchImpl = fetch }) {
  validateDeploymentId(id);
  if (typeof token !== 'string' || !token || token.length > 1024) throw new Error('Pairing token required');
  const response = await fetchImpl(`http://127.0.0.1:4317/api/jobs/${id}/artifact`, { headers: { Origin: 'http://127.0.0.1:4317', Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Artifact export failed (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 72 * 1024 * 1024) throw new Error('Artifact export too large'); chunks.push(chunk); }
  const artifact = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (artifact.id !== id || !Array.isArray(artifact.files) || artifact.files.length > 5000) throw new Error('Invalid artifact export');
  const root = await mkdtemp(path.join(tmpdir(), 'vc-publish-'));
  try {
    let total = 0;
    for (const entry of artifact.files) {
      if (typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.includes('\\') || /[\x00-\x1f\x7f]/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') || Buffer.byteLength(entry.path) > 4096 || entry.path.split('/').length > 32) throw new Error('Unsafe artifact path');
      if (typeof entry.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) throw new Error('Invalid artifact content');
      const content = Buffer.from(entry.content, 'base64'); total += content.length;
      if (total > 50 * 1024 * 1024) throw new Error('Artifact export too large');
      const target = path.join(root, entry.path); await mkdir(path.dirname(target), { recursive: true });
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
    await validateArtifacts(root, { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 });
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function deleteDeployment({ id, bucket, distribution, run = aws }) {
  validateDeploymentId(id); validateBucket(bucket); validateDistribution(distribution);
  await run(['s3', 'rm', `s3://${bucket}/deployments/${id}/`, '--recursive']);
  const result = JSON.parse(await run(['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', `/${id}/*`]));
  const invalidation = result.Invalidation?.Id;
  if (!/^[A-Z0-9]{1,32}$/.test(invalidation || '')) throw new Error('Invalidation was not confirmed');
  await run(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distribution, '--id', invalidation]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [action, id, bucket, distribution] = process.argv.slice(2);
  if (!['publish', 'delete'].includes(action) || !id || !bucket || !distribution) { console.error('Usage: node cloud/publish.mjs publish|delete JOB_ID BUCKET DISTRIBUTION_ID'); process.exitCode = 1; }
  else if (action === 'delete') {
    try { await deleteDeployment({ id, bucket, distribution }); console.log('Deleted prefix and completed CloudFront invalidation.'); }
    catch (error) { console.error(`Deletion failed: ${error.message}`); process.exitCode = 1; }
  } else {
    let root;
    try {
      let token = ''; for await (const chunk of process.stdin) { token += chunk; if (token.length > 1024) throw new Error('Pairing token too long'); }
      root = await exportJob({ id, token: token.trim() });
      console.log(await publish({ root, id, bucket, distribution }));
    } catch (error) { console.error(`Publish failed: ${error.message}. A partial prefix may remain; see cloud/README.md.`); process.exitCode = 1; }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
}
