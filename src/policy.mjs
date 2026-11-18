import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { id, checkAbort } from './util.mjs';
import { effectivePermissions, currentPermission } from './permissions.mjs';
import { approvalOptions } from './approvals.mjs';
import { selectApproval } from './ui.mjs';
export class Policy {
  constructor({ root, config, state, dialogs, getUI, scheduler, approvals }) { Object.assign(this, { root, config, state, dialogs, getUI, scheduler, approvals }); }
  get permissions() { return effectivePermissions(this.config, this.state.data.permissionPreset); }
  get preset() { return currentPermission(this.config, this.state.data.permissionPreset); }
  hasFullAccess(owner = 'root') { return this.preset.id === 'full-access' && !this.isReadOnly(owner); }
  isReadOnly(owner = 'root') {
    const thread = this.state.data.threads[owner];
    return this.state.data.mode === 'plan' || this.permissions.sandbox === 'read-only' || thread?.readOnly === true;
  }
  async path(input, { write = false, owner = 'root' } = {}) {
    let target = path.resolve(this.root, input);
    // A read follows symbolic links to the real file, which then has to pass the same boundary
    // and component checks. A write keeps the path as written, so links are still refused.
    if (!write) target = await realpath(target).catch(() => target);
    const relative = path.relative(this.root, target);
    const fullAccess = this.hasFullAccess(owner);
    if (!fullAccess && (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))) throw Error(`Path outside workspace: ${input}`);
    if (write && this.isReadOnly(owner)) throw Error('Read-only mode forbids file changes');
    if (write && !fullAccess && relative.split(path.sep).includes('.git')) throw Error('Direct changes to Git metadata are forbidden');
    const anchor = fullAccess ? path.parse(target).root : this.root;
    let current = anchor;
    for (const segment of path.relative(anchor, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw Error(`Symbolic link path is not allowed: ${current}`);
      if (stat.isFile() && write && stat.nlink > 1) throw Error(`Hard-linked files cannot be modified: ${current}`);
      if (!stat.isFile() && !stat.isDirectory()) throw Error(`Special files are not accessible: ${current}`);
    }
    if (await realpath(this.root) !== this.root) throw Error('Workspace root changed');
    return target;
  }
  recordApproval(entry) { this.state.data.approvals.push({ id: id('approval'), ...entry }); this.state.save(); }
  async authorize(operation, { owner = 'root', write = false, process = false, requireApproval = false, signal, approval } = {}) {
    checkAbort(signal);
    if (write && this.isReadOnly(owner)) throw Error('Read-only mode forbids this operation');
    if (this.hasFullAccess(owner)) return;
    const needs = requireApproval || (this.permissions.approval === 'always' && (write || process));
    if (!needs) return;
    if (this.permissions.approval === 'never') throw Error('Approval is required but policy is never');
    // Codex adjudication order: persistent prefix rules, then the session
    // approval cache, then a user decision with the Codex option set.
    if (approval && this.approvals) {
      if (this.approvals.prefixAllowed(approval)) { this.recordApproval({ owner, operation, status: 'approved', decision: 'approved', scope: 'prefix', source: 'prefix-rule' }); return; }
      if (this.approvals.session.has(approval)) { this.recordApproval({ owner, operation, status: 'approved', decision: 'approved', scope: 'session', source: 'session-cache' }); return; }
    }
    const ui = this.getUI();
    if (!ui?.available) throw Error('Approval unavailable: no TUI or RPC dialog channel');
    const options = approvalOptions(approval);
    const record = { id: id('approval'), owner, operation, status: 'pending' };
    this.state.data.approvals.push(record); this.state.save();
    try {
      const choice = await this.scheduler.pause(owner, this.dialogs.run(async () => {
        checkAbort(signal);
        return await selectApproval(ui, { owner, operation, options, mode: ui.mode, signal });
      }), signal);
      checkAbort(signal);
      const approved = ['once', 'session', 'prefix'].includes(choice);
      if (approved && (choice === 'session' || choice === 'prefix')) await this.approvals?.decide('approved', approval, options.find(item => item.id === choice));
      record.status = approved ? 'approved' : 'denied';
      record.decision = record.status;
      record.scope = choice === 'session' ? 'session' : choice === 'prefix' ? 'prefix' : 'once';
      record.source = 'user';
      this.state.save();
      if (record.status !== 'approved') throw Error('Execution approval denied');
    } catch (error) { if (record.status === 'pending') { record.status = 'cancelled'; this.state.save(); } throw error; }
  }
}
