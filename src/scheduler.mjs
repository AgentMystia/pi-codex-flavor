import { deferred, abortError } from './util.mjs';
export class Scheduler {
  constructor(limit = 16, maxQueued = 1024) { this.limit = limit; this.maxQueued = maxQueued; this.active = new Set(); this.queue = []; this.paused = new Map(); }
  acquire(owner, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active.has(owner)) return Promise.resolve();
    if (this.queue.some(item => item.owner === owner)) throw Error(`Duplicate scheduler acquisition: ${owner}`);
    if (this.queue.length >= this.maxQueued) throw Error('Execution queue is full');
    const item = { owner, signal, ...deferred() };
    item.abort = () => { this.queue = this.queue.filter(x => x !== item); item.reject(abortError()); this.drain(); };
    signal?.addEventListener('abort', item.abort, { once: true });
    this.queue.push(item); this.drain(); return item.promise;
  }
  drain() {
    while (this.active.size < this.limit && this.queue.length) {
      const item = this.queue.shift(); item.signal?.removeEventListener('abort', item.abort);
      if (item.signal?.aborted) { item.reject(abortError()); continue; }
      this.active.add(item.owner); item.resolve();
    }
  }
  release(owner) { this.active.delete(owner); this.drain(); }
  async pause(owner, promise, signal) {
    let entry = this.paused.get(owner);
    if (!entry) { entry = { count: 0, held: this.active.has(owner) }; this.paused.set(owner, entry); this.release(owner); }
    entry.count++;
    try { return await promise; }
    finally {
      if (--entry.count === 0) { this.paused.delete(owner); if (entry.held && !signal?.aborted) await this.acquire(owner, signal); }
    }
  }
  cancel(owner) { for (const item of this.queue.filter(x => x.owner === owner)) item.abort(); this.release(owner); }
  snapshot() { return { active: [...this.active], queued: this.queue.map(x => x.owner), waiting: [...this.paused.keys()], limit: this.limit }; }
}
