import { clone, id } from './util.mjs';
export const STATE_TYPE = 'pi-codex-state-v1';
// File contents kept for restore_changes. Older snapshots are dropped first once the total passes this.
export const BLOB_BUDGET_BYTES = 16 * 1024 * 1024;
const MAPS = ['tasks', 'questions', 'threads'];
const LISTS = ['decisions', 'approvals', 'changes', 'verifications', 'reviews'];
const blobSize = entry => (entry.text ?? entry.data).length;
export class State {
  constructor(persist = () => {}, entries = []) {
    this.persist = persist;
    this.data = { version: 1, mode: 'execute', permissionPreset: null, plan: [], tasks: {}, questions: {}, decisions: [], approvals: [], changes: [], verifications: [], threads: {}, reviews: [], proposedPlan: null, blobs: {} };
    for (const entry of entries.filter(e => e.customType === STATE_TYPE)) {
      const record = entry.data; if (record?.version !== 1) continue;
      if (!record.patch) this.data = clone(record);
      else for (const change of record.patch) {
        let target = this.data;
        for (const key of change.path.slice(0, -1)) target = target[key] ??= {};
        if (change.path[0] === 'blobs' && change.value == null) delete target[change.path.at(-1)];
        else target[change.path.at(-1)] = clone(change.value);
      }
    }
    this.data.blobs ??= {};
    // What the session already holds, as serialized text per item. Saving compares against
    // this instead of deep-cloning the whole state on every change.
    this.saved = new Map();
    for (const [path, value] of this.parts()) this.saved.set(path.join('\0'), JSON.stringify(value));
    this.savedBlobs = new Set(Object.keys(this.data.blobs));
  }
  *parts() {
    for (const key of Object.keys(this.data)) {
      const value = this.data[key];
      if (key === 'blobs') continue;
      if (MAPS.includes(key)) for (const item of Object.keys(value)) yield [[key, item], value[item]];
      else if (LISTS.includes(key)) for (let index = 0; index < value.length; index++) yield [[key, index], value[index]];
      else yield [[key], value];
    }
  }
  save() {
    const patch = [];
    for (const [path, value] of this.parts()) {
      const key = path.join('\0'), json = JSON.stringify(value);
      if (this.saved.get(key) === json) continue;
      this.saved.set(key, json); patch.push({ path, value: json === undefined ? null : JSON.parse(json) });
    }
    // Snapshots never change once stored, so only additions and evictions are written.
    for (const key of Object.keys(this.data.blobs)) if (!this.savedBlobs.has(key)) { this.savedBlobs.add(key); patch.push({ path: ['blobs', key], value: this.data.blobs[key] }); }
    for (const key of [...this.savedBlobs]) if (!(key in this.data.blobs)) { this.savedBlobs.delete(key); patch.push({ path: ['blobs', key], value: null }); }
    if (!patch.length) return;
    this.persist(STATE_TYPE, { version: 1, patch });
  }
  // Content-addressed snapshot store: one copy per distinct file content, text kept as text.
  putBlob(key, bytes) {
    if (this.data.blobs[key]) return;
    const text = bytes.toString('utf8');
    this.data.blobs[key] = Buffer.from(text).equals(bytes) ? { text } : { data: bytes.toString('base64') };
    let total = Object.values(this.data.blobs).reduce((sum, entry) => sum + blobSize(entry), 0);
    for (const old of Object.keys(this.data.blobs)) {
      if (total <= BLOB_BUDGET_BYTES || old === key) break;
      total -= blobSize(this.data.blobs[old]); delete this.data.blobs[old];
    }
  }
  blob(key) {
    const entry = this.data.blobs[key];
    return !entry ? undefined : entry.text !== undefined ? Buffer.from(entry.text) : Buffer.from(entry.data, 'base64');
  }
  setProposedPlan(text) {
    if (!text || !text.trim()) return this.data.proposedPlan;
    this.data.proposedPlan = { text, at: Date.now() }; this.save(); return this.data.proposedPlan;
  }
  updatePlan(plan, explanation) {
    if (plan.filter(x => x.status === 'in_progress').length > 1) throw Error('At most one step may be in progress');
    this.data.plan = clone(plan); this.data.planExplanation = explanation; this.save(); return this.data.plan;
  }
  task(input) {
    const taskId = input.id ?? id('task');
    if (input.id && !this.data.tasks[taskId]) throw Error('Unknown task');
    this.data.tasks[taskId] = { ...this.data.tasks[taskId], ...input, id: taskId };
    this.save(); return this.data.tasks[taskId];
  }
  summary() {
    return { mode: this.data.mode, permissionPreset: this.data.permissionPreset ?? null, plan: this.data.plan, tasks: this.data.tasks, decisions: this.data.decisions,
      questions: Object.values(this.data.questions).filter(q => q.status === 'pending' || q.status === 'answered'),
      threads: Object.values(this.data.threads).map(({ id, parent, status, sessionFile, role }) => ({ id, parent, status, sessionFile, role })),
      verifications: this.data.verifications.map(({ id, kind, command, status, stale }) => ({ id, kind, command, status, stale })) };
  }
  // What the model needs to keep working once its context has been summarized: open work and
  // the handles the tools accept. Finished history stays in the session, out of the prompt.
  continuity() {
    const data = this.data, tasks = Object.values(data.tasks);
    const open = tasks.filter(task => task.status !== 'completed');
    const threads = Object.values(data.threads).filter(thread => thread.status !== 'closed');
    const pending = Object.values(data.questions).filter(question => question.status === 'pending');
    const out = { mode: data.mode, permissionPreset: data.permissionPreset ?? null };
    if (data.plan.length) out.plan = data.plan;
    if (open.length) out.tasks = open.map(({ id, title, status, note }) => ({ id, title, status, ...(note ? { note } : {}) }));
    if (tasks.length > open.length) out.completedTasks = tasks.length - open.length;
    if (data.decisions.length) out.decisions = data.decisions.slice(-5).flatMap(decision => decision.questions.map(question => ({ question: question.question, answer: decision.answers[question.id]?.answers?.join('; ') })));
    if (pending.length) out.pendingQuestions = pending.map(question => question.id);
    if (threads.length) out.threads = threads.map(({ id, nickname, role, status }) => ({ id, ...(nickname ? { nickname } : {}), role, status }));
    if (data.verifications.length) out.verifications = data.verifications.slice(-5).map(({ id, kind, command, status, stale }) => ({ id, kind, command, status, stale }));
    if (data.changes.length) out.changes = data.changes.slice(-5).map(change => ({ id: change.id, paths: Object.keys(change.after) }));
    return out;
  }
}
