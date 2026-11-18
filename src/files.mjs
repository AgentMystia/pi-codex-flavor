import { createHash } from 'node:crypto';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { SerialQueue, hash, id, checkAbort, clone, bounded } from './util.mjs';
import { parsePatch, updateContent } from './patch.mjs';
import { parseIgnore, ignored } from './ignore.mjs';
import { SafeFs } from './safe-fs.mjs';
const TRACKED_BYTES = 4 * 1024 * 1024;
const SKIPPED = ['.git', 'node_modules', '.pi'];
// Snapshots hold the bytes only in memory. A change record keeps the hash and mode; the
// earlier content goes to the state's content-addressed store, once per distinct content.
async function snapshot(target, safe, owner) {
  try {
    const file = await safe.read(target, owner, TRACKED_BYTES);
    return { data: file.data, hash: hash(file.data), mode: file.mode };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const content = snap => snap ? snap.data.toString('utf8') : '';
const stored = snap => snap && { hash: snap.hash, mode: snap.mode };
const same = (a, b) => a?.hash === b?.hash && a?.mode === b?.mode;
const brief = operation => ({ kind: operation.kind, path: operation.path, ...(operation.move ? { move: operation.move } : {}) });
const slashes = (base, target) => path.relative(base, target).split(path.sep).join('/');
async function locked(paths, fn) {
  const sorted = [...new Set(paths)].sort();
  const next = index => index === sorted.length ? fn() : withFileMutationQueue(sorted[index], () => next(index + 1));
  return next(0);
}
export class Files {
  constructor({ policy, state, config }) { Object.assign(this, { policy, state, config }); this.queue = new SerialQueue(); this.safe = new SafeFs(policy); this.digests = new Map(); }
  async capture(inputs, owner, write = true) {
    const snapshots = {};
    for (const input of inputs) { const target = await this.policy.path(input, { owner, write }); snapshots[target] = await snapshot(target, this.safe, owner); }
    return snapshots;
  }
  display(target) {
    const relative = path.relative(this.policy.root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
  }
  describe(target, before, after) {
    const name = this.display(target), kind = !before ? 'A' : !after ? 'D' : 'M';
    if (before?.data.includes(0) || after?.data.includes(0)) return { path: name, kind, added: 0, removed: 0, text: `Binary file ${name} changed\n` };
    const text = createTwoFilesPatch(name, name, content(before), content(after));
    let added = 0, removed = 0;
    // The first four lines are the Index, separator and file headers.
    for (const line of text.split('\n').slice(4)) { if (line[0] === '+') added++; else if (line[0] === '-') removed++; }
    return { path: name, kind, added, removed, text };
  }
  async mutate(inputs, owner, fn, { signal, label = 'File change', expected } = {}) {
    const targets = await Promise.all(inputs.map(input => this.policy.path(input, { write: true, owner })));
    // Write approvals key the session cache per path, like Codex's
    // ApplyPatchApprovalKey entries for each file in a patch.
    await this.policy.authorize(`${label}: ${inputs.join(', ')}`, { owner, write: true, signal, approval: { kind: 'files', paths: targets } });
    return this.queue.run(() => locked(targets, async () => {
      checkAbort(signal);
      const before = await this.capture(targets, owner);
      if (expected) for (const target of targets) if (!same(before[target], expected[target])) throw Error(`Concurrent change detected: ${target}`);
      let value, failure;
      try { value = await fn(before); } catch (error) { failure = error; }
      const after = await this.capture(targets, owner);
      const paths = targets.filter(target => !same(before[target], after[target]));
      let change;
      if (paths.length) {
        for (const target of paths) if (before[target]) this.state.putBlob(before[target].hash, before[target].data);
        change = { id: id('change'), owner, label, timestamp: Date.now(), before: Object.fromEntries(paths.map(p => [p, stored(before[p])])), after: Object.fromEntries(paths.map(p => [p, stored(after[p])])), restored: false };
        this.state.data.changes.push(change); this.invalidate(paths); this.state.save();
      }
      const described = paths.map(target => this.describe(target, before[target], after[target]));
      const outcome = { change_id: change?.id, diff: described.map(file => file.text).join('\n'), files: described.map(({ text, ...file }) => file) };
      if (failure) { failure.changeId = outcome.change_id; failure.diff = outcome.diff; failure.files = outcome.files; throw failure; }
      return { value, ...outcome };
    }));
  }
  async apply(patch, owner = 'root', signal, base) {
    const operations = parsePatch(patch);
    if (base) for (const operation of operations) for (const key of ['path', 'move']) if (operation[key]) operation[key] = path.relative(this.policy.root, path.resolve(this.policy.root, base, operation[key]));
    const paths = operations.flatMap(op => [op.path, ...(op.move ? [op.move] : [])]);
    await this.capture(paths, owner);
    const completed = [];
    try {
      const mutation = await this.mutate(paths, owner, async before => {
        for (const operation of operations) {
          checkAbort(signal);
          const source = await this.policy.path(operation.path, { write: true, owner });
          const current = await snapshot(source, this.safe, owner);
          if (!same(current, before[source]) && !completed.some(op => op.path === operation.path || op.move === operation.path)) throw Error(`Concurrent modification: ${operation.path}`);
          if (operation.kind === 'add') {
            await this.safe.write(source, operation.content, owner, { exclusive: true });
          } else {
            if (!current) throw Error(`File does not exist: ${operation.path}`);
            if (operation.kind === 'delete') await this.safe.remove(source, owner);
            else {
              const next = updateContent(content(current), operation.chunks);
              if (operation.move) {
                const destination = await this.policy.path(operation.move, { write: true, owner });
                await this.safe.write(destination, next, owner, { exclusive: true, mode: current.mode });
                try { await this.safe.remove(source, owner); } catch (error) { error.message += `; destination already created: ${operation.move}`; throw error; }
              } else await this.safe.write(source, next, owner);
            }
          }
          completed.push(operation);
        }
      }, { signal, label: 'apply_patch' });
      return { status: 'applied', change_id: mutation.change_id, files: mutation.files, diff: bounded(mutation.diff, this.config.outputBytes), completed: completed.map(brief) };
    } catch (error) {
      return { status: completed.length || error.changeId ? 'partial_failure' : 'failed', error: error.message, completed: completed.map(brief), change_id: error.changeId, files: error.files ?? [], diff: bounded(error.diff ?? '', this.config.outputBytes) };
    }
  }
  async restore(changeId, selected, owner = 'root', signal) {
    const change = this.state.data.changes.find(c => c.id === changeId); if (!change) throw Error('Unknown change');
    if (!selected?.length) throw Error('Select explicit paths to restore');
    const targets = await Promise.all(selected.map(input => this.policy.path(input, { owner, write: true })));
    const earlier = new Map();
    for (const target of targets) {
      if (!(target in change.after)) throw Error('Selected file was not reliably tracked');
      const previous = change.before[target]; if (!previous) continue;
      // Records written before 0.3.0 carry the content inline as base64.
      const data = previous.data !== undefined ? Buffer.from(previous.data, 'base64') : this.state.blob(previous.hash);
      if (!data) throw Error(`The earlier content of ${this.display(target)} is no longer kept, so this change cannot be restored`);
      earlier.set(target, data);
    }
    return this.mutate(targets, owner, async () => {
      for (const target of targets) {
        checkAbort(signal);
        const previous = change.before[target];
        if (previous) { await this.safe.write(target, earlier.get(target), owner, { mode: previous.mode }); await this.safe.mode(target, previous.mode, owner); }
        else await this.safe.remove(target, owner);
      }
    }, { expected: change.after, signal, label: `Restore ${changeId}` });
  }
  invalidate(paths) {
    for (const verification of this.state.data.verifications) {
      if (paths.some(target => verification.scope.some(scope => target === scope || target.startsWith(scope + path.sep)))) verification.stale = true;
    }
  }
  // Unchanged files are not read again: size and the two timestamps identify the content the
  // way Git's index does, and the inode change time cannot be set back by a program.
  async digest(target, info) {
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = this.digests.get(target);
    if (cached?.key === key) return cached.value;
    const digest = createHash('sha256'); for await (const chunk of this.safe.chunks(target)) digest.update(chunk);
    const value = digest.digest('hex');
    if (this.digests.size >= 50000) this.digests.clear();
    this.digests.set(target, { key, value }); return value;
  }
  async fingerprint(scope = ['.']) {
    const entries = []; let count = 0;
    const rulesAt = async directory => {
      try { return [{ base: directory, rules: parseIgnore((await this.safe.read(path.join(directory, '.gitignore'), 'root', 1024 * 1024)).data.toString('utf8')) }]; }
      catch { return []; }
    };
    const walk = async (target, layers) => {
      if (++count > 100000) throw Error('Verification scope exceeds 100000 entries; choose a smaller scope');
      const info = await this.safe.info(target);
      if (!info.isDirectory()) { entries.push([target, await this.digest(target, info), info.mode]); return; }
      const inner = [...layers, ...await rulesAt(target)];
      for (const entry of (await this.safe.list(target, 'root', { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIPPED.includes(entry.name)) continue;
        const child = path.join(target, entry.name);
        if (ignored(inner, child, entry.isDirectory(), slashes)) continue;
        // A link is part of the code state as a link; what it points at is not followed.
        if (entry.isSymbolicLink()) entries.push([child, 'link', await readlink(child).catch(() => '')]);
        else if (entry.isFile() || entry.isDirectory()) await walk(child, inner);
      }
    };
    for (const input of scope) {
      const target = await this.policy.path(input);
      // Ignore files above the scope still apply inside it; the scope itself is always included.
      const layers = [], above = path.relative(this.policy.root, path.dirname(target));
      if (!above.startsWith('..') && !path.isAbsolute(above)) {
        let directory = this.policy.root; layers.push(...await rulesAt(directory));
        for (const segment of above.split(path.sep).filter(Boolean)) { directory = path.join(directory, segment); layers.push(...await rulesAt(directory)); }
      }
      await walk(target, layers);
    }
    return hash(JSON.stringify(entries));
  }
  async verify(params, executor, owner, signal, onUpdate) {
    const scope = await Promise.all((params.scope ?? ['.']).map(input => this.policy.path(input, { owner })));
    const record = { id: id('verification'), kind: params.kind, command: params.cmd, scope, status: 'not_run', stale: false, startedAt: Date.now() };
    record.before = await this.fingerprint(scope); this.state.data.verifications.push(record); this.state.save();
    // The command output goes to the caller once; the durable record keeps the outcome only.
    let output = '', dropped = 0;
    try {
      const job = await executor.launch([executor.config.shell, '--noprofile', '--norc', '-c', params.cmd], { owner, signal, onUpdate, description: params.cmd, timeoutMs: params.timeout_ms ?? 300000 });
      job.child.stdin.end(); await job.promise;
      const response = await executor.poll(job.id, owner, 0);
      output = response.output; dropped = response.dropped_bytes;
      Object.assign(record, { exitCode: response.exit_code, status: response.cancelled ? 'cancelled' : response.exit_code === 0 ? 'passed' : 'failed', error: response.error, ...(response.timed_out ? { timedOut: true } : {}) });
    } catch (error) { record.error = error.message; }
    record.after = await this.fingerprint(scope).catch(() => null);
    record.stale ||= record.before !== record.after;
    record.finishedAt = Date.now(); this.state.save(); return { ...clone(record), output, dropped_bytes: dropped };
  }
  async verificationStatus() {
    for (const v of this.state.data.verifications) if (!v.stale) v.stale = v.after !== await this.fingerprint(v.scope).catch(() => null);
    this.state.save(); return clone(this.state.data.verifications);
  }
}
