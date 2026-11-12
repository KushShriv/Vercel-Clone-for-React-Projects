import { randomBytes } from 'node:crypto';

const transitions = {
  queued: new Set(['cloning', 'failed', 'cancelled']),
  cloning: new Set(['building', 'failed', 'cancelled']),
  building: new Set(['ready', 'failed', 'cancelled']),
  ready: new Set(), failed: new Set(), cancelled: new Set(),
};
const active = state => ['queued', 'cloning', 'building'].includes(state);

export class JobStore {
  #jobs = new Map();
  constructor({ maxLogBytes = 65536 } = {}) { this.maxLogBytes = maxLogBytes; }
  create(repository) {
    if ([...this.#jobs.values()].some(job => active(job.state))) throw new Error('A job is already active');
    const job = { id: randomBytes(16).toString('hex'), repository, state: 'queued', commit: null, logs: '' };
    this.#jobs.set(job.id, job);
    return { ...job };
  }
  get(id) { const job = this.#jobs.get(id); return job && { ...job }; }
  transition(id, next) {
    const job = this.#require(id);
    if (!transitions[job.state].has(next)) throw new Error('Invalid job transition');
    if (next === 'ready' && !job.commit) throw new Error('A commit is required');
    job.state = next;
  }
  setCommit(id, sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid commit SHA');
    this.#require(id).commit = sha;
  }
  appendLog(id, text) {
    const job = this.#require(id);
    const bytes = Buffer.from(job.logs + text);
    let start = Math.max(0, bytes.length - this.maxLogBytes);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    job.logs = bytes.subarray(start).toString('utf8');
  }
  delete(id) {
    const job = this.#require(id);
    if (active(job.state)) throw new Error('Cannot delete active job');
    this.#jobs.delete(id);
  }
  #require(id) { const job = this.#jobs.get(id); if (!job) throw new Error('Job not found'); return job; }
}
