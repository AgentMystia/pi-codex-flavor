import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, getAgentDir } from '@earendil-works/pi-coding-agent';
import { validateConfig } from './config.mjs';
import { State } from './state.mjs';
import { Scheduler } from './scheduler.mjs';
import { QuestionQueue } from './questions.mjs';
import { Policy } from './policy.mjs';
import { Executor, MAX_POLL_MS } from './executor.mjs';
import { execResult, truncateMiddle, clip } from './exec-output.mjs';
import { Files } from './files.mjs';
import { Threads } from './threads.mjs';
import { Lsp } from './lsp.mjs';
import { Approvals } from './approvals.mjs';
import { readSubagentConfig, subagentsPath } from './subagents.mjs';
import { SerialQueue, result, compact, clone, id, checkAbort } from './util.mjs';
import { permissionPreset } from './permissions.mjs';
import { REVIEW_PROMPT } from './prompt.mjs';
const S = () => Type.String();
const optional = schema => Type.Optional(schema);
const number = (maximum = 30000) => Type.Integer({ minimum: 0, maximum });
const optionsSchema = Type.Array(Type.Union([S(), Type.Object({ label: S(), description: optional(S()) })]), { minItems: 2, maxItems: 6 });
const questionsSchema = Type.Array(Type.Union([
  Type.Object({ id: S(), header: optional(S()), question: S(), options: optional(optionsSchema) }),
  Type.Object({ title: S(), options: optional(optionsSchema) }),
]), { minItems: 1, maxItems: 3 });
const make = (name, description, properties, fn, format = result) => ({ name, label: name.replaceAll('_', ' '), description, parameters: Type.Object(properties), execute: async (_id, params, signal, update, ctx) => format(await fn(params, signal, update, ctx), params) });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// Codex multi_agents_common: waits run 10 s to 1 h, so a parent cannot spin on short polls.
const WAIT_MIN_MS = 10000, WAIT_MAX_MS = 3600000;
const changeLines = files => files.map(file => `${file.kind} ${file.path}${file.added || file.removed ? ` (+${file.added} -${file.removed})` : ''}`);
// The model gets the outcome and per-file line counts. The diff repeats what it just wrote,
// so that stays in details, where the tool card shows it.
function patchResult(value) {
  if (value.status === 'failed') throw Error(value.error);
  const head = value.status === 'applied' ? (value.change_id ? `Applied as ${value.change_id}` : 'Applied; the files already had this content')
    : `Partial failure: ${value.error}\nCompleted before the failure: ${value.completed.map(op => `${op.kind} ${op.path}`).join(', ') || 'none'}${value.change_id ? `\nRecorded as ${value.change_id}` : ''}`;
  const shown = [head, ...changeLines(value.files)].join('\n');
  return { content: [{ type: 'text', text: shown }], details: { ...value, display: value.diff ? `${shown}\n${value.diff}` : shown } };
}
// A sync question returns its whole record; the model already has the questions it asked.
const answerResult = value => compact(value, value.questions ? { request_id: value.id, status: value.status, ...(value.answers ? { answers: value.answers } : {}), ...(value.reason ? { reason: value.reason } : {}) } : value);
const threadBrief = thread => ({ id: thread.id, ...(thread.nickname ? { nickname: thread.nickname } : {}), status: thread.status });
const verificationLine = v => `${v.id} ${v.kind} ${v.status}${v.exitCode !== undefined && v.exitCode !== null ? ` (exit ${v.exitCode})` : ''}${v.timedOut ? ', timed out' : ''}${v.error ? `, ${v.error}` : ''}`;
const searchLines = text => { const lines = text.replace(/^\.\//gm, '').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
export class Runtime {
  static async create(options) {
    const runtime = new Runtime({ ...options, root: await realpath(options.root), config: validateConfig(options.config) });
    runtime.questions.invalidateRestored(); runtime.threads.restore();
    await runtime.approvals.load();
    await runtime.reloadSubagentGlobal();
    return runtime;
  }
  constructor({ root, config, persist, entries, getContext, getUI, deliver, agentDir, onChange = () => {} }) {
    Object.assign(this, { root, config, getContext, getUI, onChange });
    this.pendingTools = 0;
    // Session subagent override lives in memory only; it is never persisted
    // and naturally dies when the runtime is rebuilt for another session.
    this.subagentSession = null;
    this.subagentGlobal = null;
    this.agentDirValue = agentDir ?? getAgentDir();
    this.state = new State((...args) => { persist?.(...args); onChange(); }, entries);
    this.scheduler = new Scheduler(config.concurrency, config.maxQueued);
    this.dialogs = new SerialQueue();
    this.approvals = new Approvals({ agentDir: this.agentDirValue });
    const shared = { root, config, state: this.state, scheduler: this.scheduler, dialogs: this.dialogs, getUI, approvals: this.approvals };
    this.policy = new Policy(shared); this.executor = new Executor({ ...shared, policy: this.policy }); this.files = new Files({ ...shared, policy: this.policy });
    this.questions = new QuestionQueue({ ...shared, deliver: (owner, event) => {
      if (owner === 'root') deliver?.(event); else this.threads.deliver(owner, event);
    } });
    this.threads = new Threads({ ...shared, questions: this.questions, executor: this.executor,
      getContext: owner => owner === 'root' ? getContext() : this.threads.context(owner), tools: (owner, context) => this.tools(owner, context),
      resolveSubagent: context => this.resolveSubagent(context), notify: text => this.agentNotice?.(text), onChange });
    this.lsp = config.lsp.length ? new Lsp({ ...shared, policy: this.policy, executor: this.executor, files: this.files }) : undefined;
  }
  async reloadSubagentGlobal() {
    this.subagentGlobal = await readSubagentConfig(subagentsPath(this.agentDirValue));
    return this.subagentGlobal;
  }
  // Codex layers spawn-time agent config over the parent's; here the /subagent
  // session override wins over the global file, and both fall back to
  // inheriting the spawning context.
  resolveSubagent(context) {
    const inherit = { model: context.model, thinking: context.thinkingLevel ?? 'medium', source: 'inherit' };
    for (const [source, configured] of [['session', this.subagentSession], ['global', this.subagentGlobal]]) {
      if (!configured) continue;
      const model = configured.model && context.modelRegistry?.find ? context.modelRegistry.find(configured.model.provider, configured.model.id) : undefined;
      if (configured.model && !model) return { ...inherit, source, note: `configured model ${configured.model.provider}/${configured.model.id} unavailable; inherited` };
      return { model: model ?? context.model, thinking: configured.thinking && configured.thinking !== 'inherit' ? configured.thinking : inherit.thinking, source };
    }
    return inherit;
  }
  async setMode(mode) {
    if (this.scheduler.active.size || [...this.executor.jobs.values()].some(j => !j.done)) throw Error('Wait for running agents and processes before changing mode');
    this.state.data.mode = mode; this.state.save(); return mode;
  }
  assertPermissionChangeIdle() {
    const scheduler = this.scheduler.snapshot();
    const busyThreads = Object.values(this.state.data.threads).some(thread => ['running', 'queued', 'waiting', 'waiting_input'].includes(thread.status));
    const pendingInput = Object.values(this.state.data.questions).some(question => question.status === 'pending') || this.state.data.approvals.some(approval => approval.status === 'pending');
    if (this.pendingTools || this.executor.pendingLaunches || scheduler.active.length || scheduler.queued.length || scheduler.waiting.length || busyThreads || pendingInput || [...this.executor.jobs.values()].some(job => !job.done)) {
      throw Error('请先停止当前任务、待答交互和后台进程，再切换权限。');
    }
  }
  setPermission(value) {
    const preset = permissionPreset(value);
    if (!preset) throw Error('请选择 Ask for Approval、Full Access 或 Read-Only。');
    this.assertPermissionChangeIdle();
    this.state.data.permissionPreset = preset.id; this.state.save(); return preset;
  }
  // Whether the owner has input waiting: user steering for the main session, a queued
  // parent message for a delegated thread.
  hasInput(owner, ctx) {
    if (owner === 'root') { const context = ctx ?? this.getContext?.(); return () => !!context?.hasPendingMessages?.(); }
    return () => !!this.threads.live.get(owner)?.agent?.hasQueuedMessages?.();
  }
  // `hinted` is the tool's own readOnlyHint annotation. It is a declaration by the tool's
  // server, not something this suite can verify.
  async guardExternal(name, owner, signal, hinted = false) {
    const readOnly = hinted || this.config.mcpReadOnly.includes(name);
    if (this.policy.isReadOnly(owner) && !readOnly) throw Error('Read-only mode blocks external tools that are not marked read-only');
    await this.policy.authorize(`External tool ${name}: executes in its own service, outside the local OS sandbox`, { owner, signal, requireApproval: !readOnly, approval: { kind: 'external', name } });
  }
  // Search results name files relative to the workspace, the form every file tool accepts.
  searchPath(target) {
    const relative = path.relative(this.root, target);
    return relative.startsWith('..') || path.isAbsolute(relative) ? target : './' + relative;
  }
  // Pi pages long files itself, but this suite's result cap is smaller. Cut on a line
  // boundary and say where to continue, so the rest of the file stays reachable.
  pageRead(output, params) {
    const budget = this.config.outputBytes - 160;
    return { ...output, content: output.content.map(block => {
      if (block.type !== 'text' || Buffer.byteLength(block.text) <= budget) return block;
      const bytes = Buffer.from(block.text), end = bytes.lastIndexOf(10, budget);
      if (end <= 0) return block;
      const kept = bytes.subarray(0, end).toString('utf8');
      return { ...block, text: `${kept}\n\n[Cut to fit the result size limit. Use offset=${(params.offset ?? 1) + kept.split('\n').length} to continue.]` };
    }) };
  }
  fileTools(owner, getContext) {
    const wrap = (definition, fn) => ({ ...definition, execute: async (callId, params, signal, update, ctx) => {
      checkAbort(signal); const target = await this.policy.path(params.path ?? '.', { owner });
      return fn ? fn(definition, callId, { ...params, path: target }, signal, update, ctx ?? getContext()) : definition.execute(callId, { ...params, path: target }, signal, update, ctx ?? getContext());
    } });
    const read = wrap(createReadToolDefinition(this.root, { operations: {
      readFile: async p => (await this.files.safe.read(p, owner)).data,
      createReadStream: (p, { signal }) => this.files.safe.chunks(p, owner, signal),
      access: async p => { await this.policy.path(p, { owner }); },
      detectImageMimeType: async p => {
        const data = await this.files.safe.header(p, owner);
        if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
        if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
        if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return 'image/gif';
        if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
        if (data.subarray(0, 2).toString() === 'BM') return 'image/bmp';
        return null;
      },
    } }), async (definition, callId, params, signal, update, ctx) => this.pageRead(await definition.execute(callId, params, signal, update, ctx), params));
    const ls = wrap(createLsToolDefinition(this.root, { operations: {
      exists: async p => this.files.safe.info(p, owner).then(() => true, () => false),
      stat: async p => this.files.safe.info(p, owner),
      readdir: async p => this.files.safe.list(p, owner),
    } }));
    const writes = ['write', 'edit'].map(name => {
      const base = name === 'write' ? createWriteToolDefinition(this.root) : createEditToolDefinition(this.root);
      return { ...base, execute: async (callId, params, signal, update, ctx) => {
        const target = await this.policy.path(params.path, { owner, write: true });
        const expected = await this.files.capture([target], owner); let staged;
        const virtual = name === 'write' ? createWriteToolDefinition(this.root, { operations: { mkdir: async () => {}, writeFile: async (_p, data) => { staged = data; } } }) : createEditToolDefinition(this.root, { operations: {
          readFile: async () => { if (!expected[target]) throw Error('File does not exist'); return expected[target].data; },
          access: async () => { if (!expected[target]) throw Error('File does not exist'); }, writeFile: async (_p, data) => { staged = data; },
        } });
        const output = await virtual.execute(callId, { ...params, path: target }, signal, update, ctx ?? getContext());
        if (staged === undefined) throw Error('Pi did not produce a file change');
        const mutation = await this.files.mutate([target], owner, async () => {
          await this.files.safe.write(target, staged, owner);
        }, { signal, expected, label: name });
        return { ...output, details: { ...output.details, change_id: mutation.change_id, patch: mutation.diff } };
      } };
    });
    const grep = wrap(createGrepToolDefinition(this.root), async (_definition, _callId, params, signal) => {
      const limit = Math.max(1, params.limit ?? 100);
      const argv = ['rg', '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--max-count', String(limit), '--max-columns', '400', '--max-columns-preview'];
      if (params.ignoreCase) argv.push('-i'); if (params.literal) argv.push('-F');
      if (params.context) argv.push('-C', String(Math.min(50, params.context))); if (params.glob) argv.push('--glob', params.glob);
      argv.push('--', params.pattern, this.searchPath(params.path));
      const output = await this.executor.capture(argv, { owner, signal, readOnly: true });
      if (output.exit_code !== 0 && output.exit_code !== 1) throw Error(output.output || 'Search failed');
      // rg caps matches per file; `limit` is the cap for the whole result.
      const lines = searchLines(output.output), isMatch = line => !params.context || /^.*?:\d+:/.test(line);
      let kept = lines.length, seen = 0;
      for (let i = 0; i < lines.length; i++) if (isMatch(lines[i]) && ++seen > limit) { kept = i; break; }
      const more = lines.slice(kept).filter(isMatch).length;
      const notes = [more ? `[${more}+ more matching lines not shown; narrow the pattern or path, or raise limit]` : '', output.dropped_bytes ? '[Output exceeded the size limit; narrow the search]' : ''].filter(Boolean);
      return compact({ exit_code: output.exit_code, matches: Math.min(seen, limit), more }, [...lines.slice(0, kept), ...notes].join('\n') || 'No matches found');
    });
    const find = wrap(createFindToolDefinition(this.root), async (_definition, _callId, params, signal) => {
      const output = await this.executor.capture(['rg', '--files', '--hidden', '--sort', 'path', '--glob', '!.git/**', '--glob', params.pattern, '--', this.searchPath(params.path)], { owner, signal, readOnly: true });
      if (output.exit_code !== 0 && output.exit_code !== 1) throw Error(output.output || 'Find failed');
      const lines = searchLines(output.output), limit = Math.max(1, params.limit ?? 1000), more = lines.length - limit;
      return compact({ exit_code: output.exit_code, files: Math.min(lines.length, limit) }, [...lines.slice(0, limit), ...(more > 0 ? [`[${more} more files not shown; narrow the pattern or raise limit]`] : [])].join('\n') || 'No files found');
    });
    return [read, grep, find, ls, ...writes];
  }
  tools(owner = 'root', getContext = this.getContext) {
    const tools = this.fileTools(owner, getContext);
    tools.push(
      make('request_user_input', 'Ask one to three explicit user questions; wait for the answers. A question never grants execution permission.', { questions: questionsSchema, context: optional(S()), timeout_ms: optional(number(86400000)) },
        (p, signal) => this.questions.request(owner, p.questions, { signal, context: p.context, timeoutMs: p.timeout_ms }), answerResult),
      make('request_user_input_async', 'Queue questions and immediately return a request id. Explicit answers arrive in a correlated user_input_response event. Continue independent work.', { questions: questionsSchema, context: optional(S()), timeout_ms: optional(number(86400000)) },
        (p, signal) => this.questions.request(owner, p.questions, { async: this.state.data.mode !== 'plan', signal, context: p.context, timeoutMs: p.timeout_ms }), answerResult),
      make('cancel_user_input', 'Cancel your own pending question. Cancellation cannot approve or trigger dependent work.', { request_id: S() }, p => {
        const q = this.state.data.questions[p.request_id]; if (!q || q.owner !== owner) throw Error('Unknown question or different owner'); this.questions.cancel(p.request_id); return { status: q.status };
      }),
      make('update_plan', 'Record ordered steps and their status, with at most one step in progress.', { explanation: optional(S()), plan: Type.Array(Type.Object({ step: S(), status: Type.Union(['pending', 'in_progress', 'completed'].map(Type.Literal)) }), { minItems: 1 }) },
        p => {
          if (this.state.data.mode === 'plan') throw Error('update_plan is a TODO/checklist tool and is not allowed in Plan mode');
          return this.state.updatePlan(p.plan, p.explanation);
        }, value => compact(value, 'Plan updated')),
      make('task_status', 'Create or update a task or list task status.', { id: optional(S()), title: optional(S()), status: optional(Type.Union(['pending', 'in_progress', 'completed', 'blocked'].map(Type.Literal))), note: optional(S()) }, p => Object.keys(p).length ? this.state.task({ ...p, owner }) : this.state.data.tasks,
        (value, p) => Object.keys(p).length ? compact(value, `${value.id} ${value.status ?? 'pending'}`)
          : compact(value, Object.values(value).map(task => `${task.id} ${task.status ?? 'pending'} ${task.title ?? ''}${task.note ? ` (${task.note})` : ''}`).join('\n') || 'No tasks')),
      make('exec_command', 'Execute through the user-selected permission policy. Host access under restricted presets requires require_escalated with a justification and separate approval; Read-Only forbids escalation. Waits up to yield_time_ms (default 10000) for the command to finish; a longer command keeps running and returns a session ID for write_stdin. Native PTY is not enabled.', { cmd: S(), workdir: optional(S()), yield_time_ms: optional(number()), timeout_ms: optional(number(86400000)), max_output_tokens: optional(number(1000000)), require_approval: optional(Type.Boolean()), sandbox_permissions: optional(Type.Union(['use_default', 'require_escalated'].map(Type.Literal))), justification: optional(S()) },
        (p, signal, update) => this.executor.exec({ ...p, yield_time_ms: clamp(p.yield_time_ms ?? 10000, 250, 30000) }, owner, signal, update), (value, p) => execResult(value, this.config.outputBytes, p.max_output_tokens)),
      make('write_stdin', 'Write stdin, send EOF or cancel a process owned by this agent, then return its new output. Input waits up to 30 s (default 250 ms). With nothing to send it waits 5 s to 300 s (default 5 s) unless the process ends or the user sends a message first; for a long job, wait long once instead of polling often.', { session_id: Type.Integer({ minimum: 1000, maximum: 99999 }), chars: optional(S()), yield_time_ms: optional(number(MAX_POLL_MS)), max_output_tokens: optional(number(1000000)), eof: optional(Type.Boolean()), cancel: optional(Type.Boolean()) }, (p, _signal, _update, ctx) => {
        const empty = !(p.chars || p.eof || p.cancel);
        return this.executor.write({ ...p, yield_time_ms: empty ? clamp(p.yield_time_ms ?? 5000, 5000, MAX_POLL_MS) : clamp(p.yield_time_ms ?? 250, 250, 30000) }, owner, empty ? this.hasInput(owner, ctx) : undefined);
      }, (value, p) => execResult(value, this.config.outputBytes, p.max_output_tokens, 'write_stdin')),
      make('apply_patch', 'Apply Codex-format add, update, delete and move operations through the shared tracked mutation queue. Returns the change id and per-file line counts; a partial failure lists what completed.', { patch: S() }, (p, signal) => this.files.apply(p.patch, owner, signal), patchResult),
      make('restore_changes', 'Restore explicitly selected tracked files only if their current content still matches the recorded result. Shell side effects cannot be restored.', { change_id: S(), paths: Type.Array(S(), { minItems: 1 }) }, (p, signal) => this.files.restore(p.change_id, p.paths, owner, signal),
        value => compact(value, [value.change_id ? `Restored as ${value.change_id}` : 'Nothing to restore; the files already had the earlier content', ...changeLines(value.files)].join('\n'))),
      make('run_verification', 'Run a chosen project check and bind its result to the code state. Choose checks from project instructions and existing scripts.', { kind: Type.Union(['test', 'typecheck', 'lint', 'build', 'other'].map(Type.Literal)), cmd: S(), scope: optional(Type.Array(S(), { minItems: 1 })), timeout_ms: optional(number(86400000)) },
        (p, signal, update) => this.files.verify(p, this.executor, owner, signal, update), value => {
          const { output, dropped_bytes, ...record } = value;
          return compact(record, [`${verificationLine(record)}${record.stale ? '; stale: files in scope changed during the check' : ''}`, clip(output, this.config.outputBytes - 600)].filter(Boolean).join('\n'));
        }),
      make('verification_status', 'Recheck code fingerprints and distinguish current results from stale evidence.', {}, () => this.files.verificationStatus(),
        value => compact(value, value.map(v => `${verificationLine(v)}, ${v.stale ? 'stale' : 'current'}: ${v.command}`).join('\n') || 'No verification has run')),
      make('spawn_agent', 'Create a persistent child thread, optionally fork context. Model and thinking follow the /subagent configuration when set (session over global); otherwise they inherit. Nested delegation is allowed within the depth limit.', { message: S(), role: optional(Type.Union(['worker', 'scout', 'reviewer', 'tester'].map(Type.Literal))), fork_context: optional(Type.Boolean()) }, p => this.threads.spawn(owner, p)),
      make('send_agent_message', 'Send an ordered message to your parent or descendant by thread id or nickname. Set steer to guide an active agent promptly.', { id: S(), message: S(), steer: optional(Type.Boolean()) }, p => {
        if (p.id === 'root' && owner !== 'root') { this.parentMessage?.(owner, p.message); return { delivered: true }; }
        return this.threads.send(owner, p.id, p.message, p);
      }, value => compact(value, { delivered: true, ...(value.sequence ? { sequence: value.sequence } : {}) })),
      make('wait_agents', 'Wait until all listed threads finish, releasing execution capacity. Returns early when new input for you arrives (interrupted_by_input) or at timeout_ms (10 s to 1 h, default 30 s). Returns a compact status map plus bounded outputs of finished threads. A thread that finishes while you are not waiting on it sends you a <subagent_notification> with its outcome, so keep working instead of polling. Wait cycles are rejected.', { ids: Type.Array(S(), { minItems: 1 }), timeout_ms: optional(number(WAIT_MAX_MS)) },
        (p, signal, _update, ctx) => this.threads.wait(owner, p.ids, { signal, timeoutMs: clamp(p.timeout_ms ?? 30000, WAIT_MIN_MS, WAIT_MAX_MS), hasInput: this.hasInput(owner, ctx) })),
      make('list_agents', 'Inspect persistent thread states and shared execution capacity without waking agents.', {}, () => ({ threads: Object.values(this.state.data.threads).map(({ id, nickname, role, status, depth, parent, modelSource }) => ({ id, ...(nickname ? { nickname } : {}), role, status, depth, parent, ...(modelSource ? { modelSource } : {}) })), scheduler: this.scheduler.snapshot() })),
      make('interrupt_agent', 'Interrupt a descendant by thread id or nickname and clean up its running processes and pending questions.', { id: S() }, p => this.threads.interrupt(owner, p.id), value => compact(value, threadBrief(value))),
      make('close_agent', 'Close a descendant and its descendants by thread id or nickname, invalidate pending questions and release resources.', { id: S() }, p => this.threads.interrupt(owner, p.id, true), value => compact(value, threadBrief(value))),
      make('resume_agent', 'Explicitly resume a completed, interrupted, idle or closed descendant by thread id or nickname using its persistent thread.', { id: S(), message: optional(S()) }, p => this.threads.resume(owner, p.id, p.message), value => compact(value, threadBrief(value))),
      make('compact_agent', 'On demand, compact an idle descendant by thread id or nickname through Pi summarization, preserving durable task and decision references. This is an explicit model request, never a background UI action.', { id: S(), instructions: optional(S()) }, (p, signal) => this.threads.compact(owner, p.id, p.instructions, signal), value => compact(value, { id: value.id, compacted: true, summary: value.summary })),
      make('review_diff', 'Read Git diff for workspace, staged changes or an explicit revision range without modifying Git state.', { target: Type.Union(['workspace', 'staged', 'range'].map(Type.Literal)), range: optional(S()), paths: optional(Type.Array(S())) }, (p, signal) => this.reviewDiff(p, owner, signal), value => ({ ...result(value.output), details: value })),
      make('review_comment', 'Return a concrete review finding with a workspace path and line number.', { path: S(), line: Type.Integer({ minimum: 1 }), severity: Type.Union(['info', 'warning', 'error'].map(Type.Literal)), comment: S() }, async p => {
        const target = await this.policy.path(p.path, { owner }); const review = { ...p, path: target, owner, id: id('review') }; this.state.data.reviews.push(review); this.state.save(); return review;
      }, value => compact(value, `Recorded ${value.id}`)),
      make('load_workflow', 'Load a concise implementation, debugging, refactoring, testing or review workflow on demand.', { name: Type.Union(['implement', 'debug', 'refactor', 'test', 'review'].map(Type.Literal)) }, async p => {
        const workflow = await readFile(new URL(`../workflows/${p.name}.md`, import.meta.url), 'utf8');
        return p.name === 'review' ? workflow + '\n\n' + REVIEW_PROMPT : workflow;
      }),
    );
    if (this.lsp) tools.push(
      make('lsp', 'Query an explicitly configured language server on demand: definition, references, hover, symbols, diagnostics or code action previews. Commands are never executed.', { path: S(), method: Type.Union(['definition', 'references', 'hover', 'symbols', 'diagnostics', 'code_actions'].map(Type.Literal)), line: optional(number(1000000)), character: optional(number(1000000)), server: optional(S()) }, (p, signal) => this.lsp.query(p, owner, signal)),
      make('lsp_apply', 'Apply a previously returned LSP code action preview through the tracked mutation queue, rejecting stale content.', { preview_id: S() }, (p, signal) => this.lsp.apply(p.preview_id, owner, signal)),
    );
    return tools.map(tool => ({ ...tool, execute: async (...args) => {
      this.pendingTools++;
      try {
        const output = await tool.execute(...args);
        // Codex truncates function output in the middle; trailing notes and late errors survive.
        return output.details?.execution ? output : { ...output, content: output.content.map(block => block.type === 'text' ? { ...block, text: clip(block.text, this.config.outputBytes) } : block) };
      } catch (error) {
        // Like Codex's EXEC_COMMAND_REJECTION_MAX_BYTES + truncate_middle_chars,
        // bound rejection text so a failing tool cannot flood model context.
        throw Error(truncateMiddle(error instanceof Error ? error.message : String(error), 900));
      } finally { this.pendingTools--; }
    } }));
  }
  async reviewDiff(params, owner, signal) {
    const argv = ['git', '-c', 'core.fsmonitor=false', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv'];
    if (params.target === 'staged') argv.push('--cached');
    if (params.target === 'range') { if (!params.range || params.range.startsWith('-') || /[\0\r\n]/.test(params.range)) throw Error('An explicit revision range is required'); argv.push(params.range); }
    if (params.paths) { argv.push('--'); for (const p of params.paths) argv.push(path.relative(this.root, await this.policy.path(p, { owner }))); }
    const response = await this.executor.capture(argv, { owner, signal, readOnly: true });
    if (response.exit_code !== 0) throw Error(response.output || 'Git diff failed'); return response;
  }
  async close() { this.questions.close(); await this.threads.close(); await this.lsp?.close(); await this.executor.close(); this.scheduler.cancel('root'); }
}
