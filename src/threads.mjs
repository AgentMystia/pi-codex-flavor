import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { SessionManager, convertToLlm, generateSummaryWithUsage, estimateTokens, compact as summarizeCompaction, findCutPoint, calculateContextTokens, DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import { id, clone, deferred, checkAbort, whenInput } from './util.mjs';
import { clip } from './exec-output.mjs';
import { composeAgentPrompt } from './prompt.mjs';
const terminal = status => ['completed', 'failed', 'interrupted', 'closed'].includes(status);
const overflow = (message, model) => message?.role === 'assistant' && message.stopReason === 'error' && isContextOverflow(message, model?.contextWindow);
// Pi's defaults assume a large window. A smaller one keeps the same shape: the reserve stays a
// quarter of the window at most, and the verbatim tail leaves room for the summary and new work.
export function compactionLimits(contextWindow) {
  const reserve = Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(contextWindow / 4));
  return { reserve, keep: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor((contextWindow - reserve) / 2)) };
}
// Usage reported before the latest compaction counts messages that are gone, so only usage from
// `floor` onward is trusted; everything after the last trusted usage is estimated.
export function contextTokens(messages, systemPrompt = '', floor = 0) {
  for (let index = messages.length - 1; index >= floor; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted' || !message.usage) continue;
    const used = calculateContextTokens(message.usage);
    if (used > 0) return used + messages.slice(index + 1).reduce((sum, item) => sum + estimateTokens(item), 0);
  }
  return Math.ceil(Buffer.byteLength(systemPrompt) / 4) + messages.reduce((sum, item) => sum + estimateTokens(item), 0);
}
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
function fileOperations(messages, previous) {
  const read = new Set(previous?.readFiles ?? []), edited = new Set(previous?.modifiedFiles ?? []);
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call.type !== 'toolCall' || !call.arguments) continue;
      if (call.name === 'read' && call.arguments.path) read.add(call.arguments.path);
      else if ((call.name === 'write' || call.name === 'edit') && call.arguments.path) edited.add(call.arguments.path);
      else if (call.name === 'apply_patch' && typeof call.arguments.patch === 'string') for (const match of call.arguments.patch.matchAll(PATCH_FILE)) edited.add((match[1] ?? match[2]).trim());
    }
  }
  return { read, written: new Set(), edited };
}
// The thread session is linear: messages and compactions only. This mirrors Pi's own
// preparation on that shape, which Pi 1.5.2 does not export: summarize what the latest
// compaction kept plus everything up to a cut point, and keep the most recent tail verbatim.
export function prepareThreadCompaction(entries, keepRecentTokens, tokensBefore) {
  if (entries.at(-1)?.type === 'compaction') return undefined;
  const last = entries.findLastIndex(entry => entry.type === 'compaction');
  const previous = entries[last];
  const kept = previous?.firstKeptEntryId ? entries.findIndex(entry => entry.id === previous.firstKeptEntryId) : -1;
  const cut = findCutPoint(entries, last + 1, entries.length, keepRecentTokens);
  const first = entries[cut.firstKeptEntryIndex];
  if (!first?.id) return undefined;
  const messages = (from, to) => entries.slice(from, to).filter(entry => entry.type === 'message').map(entry => entry.message);
  const messagesToSummarize = [...(kept >= 0 && kept < last ? messages(kept, last) : []), ...messages(last + 1, cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex)];
  const turnPrefixMessages = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
  return { firstKeptEntryId: first.id, messagesToSummarize, turnPrefixMessages, isSplitTurn: cut.isSplitTurn, tokensBefore, previousSummary: previous?.summary,
    fileOps: fileOperations([...messagesToSummarize, ...turnPrefixMessages], previous?.details), settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens } };
}
// The failures Pi's own agent-level retry treats as temporary. Quota and billing replies are final.
const MAX_RETRIES = 3;
const FINAL = /insufficient_quota|quota exceeded|billing|usage limit|available balance|"code"\s*:\s*"?1308(?![0-9])/i;
const TRANSIENT = /overloaded|server_busy|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|upstream|network.?error|connection.?(?:error|refused|lost|reset)|other side closed|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timed? out|timeout|terminated|stream ended|ended without/i;
const transient = text => typeof text === 'string' && !FINAL.test(text) && TRANSIENT.test(text);
const sleep = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
export function forkMessages(messages) {
  const copied = messages.filter(message => message.role !== 'system').map(clone);
  for (let index = 0; index < copied.length; index++) {
    const calls = copied[index].role === 'assistant' ? copied[index].content.filter(c => c.type === 'toolCall') : [];
    if (calls.length && calls.some(call => !copied.slice(index + 1).some(message => message.role === 'toolResult' && message.toolCallId === call.id))) return copied.slice(0, index);
  }
  return copied;
}
export class Threads {
  constructor({ state, scheduler, questions, executor, config, getContext, tools, resolveSubagent, notify, onChange = () => {} }) {
    Object.assign(this, { state, scheduler, questions, executor, config, getContext, tools, resolveSubagent, notify, onChange });
    this.live = new Map(); this.edges = new Map(); this.sequence = 0; this.roleCounts = new Map(); this.closed = false;
    this.retryDelayMs = 2000;
  }
  view(threadId) { const item = this.state.data.threads[threadId]; if (!item) throw Error('Unknown agent thread'); return clone(item); }
  // Codex addresses agents by legible nicknames; ids remain canonical and any
  // nickname resolves back to its thread for messaging and control tools.
  resolve(reference) {
    if (typeof reference === 'string' && this.state.data.threads[reference]) return reference;
    const match = Object.values(this.state.data.threads).find(item => item.nickname === reference);
    if (!match) throw Error(`Unknown agent thread: ${reference}`);
    return match.id;
  }
  nickname(owner) { return owner === 'root' ? 'root' : this.state.data.threads[owner]?.nickname ?? owner; }
  owns(owner, threadId) {
    let item = this.state.data.threads[threadId];
    while (item) { if (item.id === owner || item.parent === owner) return true; item = this.state.data.threads[item.parent]; }
    return owner === 'root';
  }
  assertOwns(owner, threadId) { if (!this.owns(owner, threadId)) throw Error('Cannot control a thread outside your descendants'); }
  spawn(owner, args) {
    if (this.closed) throw Error('Thread manager is closed');
    const parent = this.state.data.threads[owner];
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.config.maxDepth) throw Error('Maximum delegation depth reached');
    if (Object.values(this.state.data.threads).filter(t => !terminal(t.status) && t.status !== 'idle').length >= this.config.maxQueued) throw Error('Agent queue is full');
    const context = this.getContext(owner);
    // Codex layers spawn-time config over the turn config; here the /subagent
    // configuration (session over global) replaces blind inheritance.
    const resolved = this.resolveSubagent?.(context) ?? { model: context.model, thinking: context.thinkingLevel ?? 'medium', source: 'inherit' };
    if (!resolved.model) throw Error('Select a model before delegating');
    const role = args.role ?? 'worker';
    const readOnly = parent?.readOnly || this.state.data.mode === 'plan' || role === 'reviewer';
    const threadId = id('agent');
    const count = (this.roleCounts.get(role) ?? 0) + 1; this.roleCounts.set(role, count);
    const item = { id: threadId, nickname: `${role}-${count}`, parent: owner, depth, role, readOnly: !!readOnly,
      model: clone(resolved.model), thinkingLevel: resolved.thinking, modelSource: resolved.source ?? 'inherit',
      ...(resolved.note ? { modelNote: resolved.note } : {}),
      status: 'queued', task: args.message, fork: !!args.fork_context, mailbox: [], createdAt: Date.now() };
    this.state.data.threads[threadId] = item;
    const messages = args.fork_context ? forkMessages(context.sessionManager.buildSessionProjection?.().messages ?? []) : [];
    const sessionManager = SessionManager.create(context.cwd, path.join(context.sessionManager.getSessionDir(), 'pi-codex-threads'));
    for (const message of messages) sessionManager.appendMessage(message);
    item.sessionFile = sessionManager.getSessionFile();
    const live = { controller: new AbortController(), sessionManager, settled: deferred(), context, systemPrompt: context.getSystemPrompt() };
    this.live.set(threadId, live); this.state.save(); this.onChange();
    live.run = this.run(item, live, args.message).catch(error => { item.status = 'failed'; item.error = error.message; this.state.save(); });
    return { id: threadId, nickname: item.nickname, status: item.status, parent: owner };
  }
  async run(item, live, message) {
    try {
      await this.scheduler.acquire(item.id, live.controller.signal); checkAbort(live.controller.signal);
      item.status = 'running'; this.state.save(); this.onChange();
      if (!live.agent) {
        const definitions = this.tools(item.id, () => this.context(item.id));
        const agentTools = definitions.map(definition => ({ ...definition, execute: (callId, params, signal, update) => definition.execute(callId, params, signal, update, this.context(item.id)) }));
        const messages = live.sessionManager.buildSessionContext().messages.filter(m => m.role !== 'system');
        live.usageFloor = messages.some(m => m.role === 'compactionSummary') ? messages.length : 0;
        live.agent = new Agent({
          initialState: { model: item.model, thinkingLevel: item.thinkingLevel, systemPrompt: composeAgentPrompt(live.systemPrompt, item.role, item.readOnly), messages, tools: agentTools },
          convertToLlm, streamFn: (model, transcript, options) => live.context.modelRegistry.streamSimple(model, transcript, options),
          sessionId: live.sessionManager.getSessionId(), steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
          // Pi compacts the main session as it nears the context window; a delegated thread
          // gets the same before each request, so long work does not end in an overflow.
          prepareRequest: async ({ context }, signal) => {
            const window = item.model?.contextWindow;
            if (!window || contextTokens(context.messages, context.systemPrompt, live.usageFloor) <= window - compactionLimits(window).reserve) return undefined;
            const compacted = await this.autoCompact(item, live, signal).catch(() => undefined);
            return compacted ? { context: { ...context, messages: compacted } } : undefined;
          },
        });
        live.agent.subscribe(event => {
          if (event.type !== 'message_end' || event.message.role === 'system') return;
          // A failed attempt that is about to be retried stays out of the thread's history.
          if (overflow(event.message, item.model) ? !live.overflowRecovered : event.message.stopReason === 'error' && transient(event.message.errorMessage) && (live.attempts ?? 0) < MAX_RETRIES) return;
          live.sessionManager.appendMessage(clone(event.message));
        });
      }
      const abort = () => live.agent.abort(); live.controller.signal.addEventListener('abort', abort, { once: true });
      try { live.attempts = 0; live.overflowRecovered = false; await live.agent.prompt(message); await this.recover(item, live); } finally { live.controller.signal.removeEventListener('abort', abort); }
      const last = [...live.agent.state.messages].reverse().find(m => m.role === 'assistant');
      item.output = last?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
      if (last?.stopReason === 'error') { item.status = 'failed'; item.error = last.errorMessage; }
      else if (live.controller.signal.aborted || last?.stopReason === 'aborted') item.status = 'interrupted';
      else item.status = Object.values(this.state.data.questions).some(q => q.owner === item.id && q.status === 'pending') ? 'waiting_input' : 'completed';
    } catch (error) { item.status = live.controller.signal.aborted ? 'interrupted' : 'failed'; item.error = error.message; }
    finally {
      this.scheduler.cancel(item.id); item.finishedAt = Date.now();
      if (['failed', 'interrupted', 'closed'].includes(item.status)) this.questions.cancelOwner(item.id);
      await this.executor.cancelOwner(item.id);
      this.notifyParent(item, live);
      this.state.save(); this.onChange(); live.settled.resolve(this.view(item.id));
    }
  }
  // Pi retries temporary provider failures for the main session. Child threads get the same
  // here, so one rate-limit reply under high concurrency does not fail a whole thread. The
  // execution slot is free while a thread waits to retry. A context overflow is compacted
  // once and continued, the way Pi recovers its main session.
  async recover(item, live) {
    const signal = live.controller.signal;
    for (;;) {
      const last = live.agent.state.messages.at(-1);
      if (signal.aborted || last?.role !== 'assistant' || last.stopReason !== 'error') return;
      if (overflow(last, item.model)) {
        if (live.overflowRecovered) return;
        live.overflowRecovered = true;
        live.agent.state.messages = live.agent.state.messages.slice(0, -1);
        const compacted = await this.autoCompact(item, live, signal).catch(() => undefined);
        if (!compacted) { live.agent.state.messages = [...live.agent.state.messages, last]; live.sessionManager.appendMessage(clone(last)); return; }
        live.agent.state.messages = compacted;
      } else {
        if (live.attempts >= MAX_RETRIES || !transient(last.errorMessage)) return;
        const delay = this.retryDelayMs * 2 ** live.attempts++;
        item.retries = (item.retries ?? 0) + 1;
        await this.scheduler.pause(item.id, sleep(delay, signal), signal);
        if (signal.aborted) return;
        live.agent.state.messages = live.agent.state.messages.slice(0, -1);
      }
      await live.agent.continue();
    }
  }
  async autoCompact(item, live, signal) {
    const entries = live.sessionManager.getBranch();
    const messages = live.agent?.state.messages ?? [];
    const preparation = prepareThreadCompaction(entries, compactionLimits(item.model.contextWindow).keep, contextTokens(messages, '', live.usageFloor ?? 0));
    if (!preparation) return undefined;
    const result = await summarizeCompaction(preparation, item.model, undefined, undefined,
      `This is a delegated agent thread; keep its assignment, constraints, findings, file changes and verification state precise.\nAssignment: ${clip(item.task ?? '', 4000)}`,
      signal, item.thinkingLevel, (model, context, options) => live.context.modelRegistry.streamSimple(model, context, options), undefined, undefined, undefined, live.sessionManager.getSessionId());
    checkAbort(signal);
    live.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, false, result.usage);
    const compacted = live.sessionManager.buildSessionContext().messages.filter(m => m.role !== 'system');
    live.usageFloor = compacted.length;
    if (live.agent) live.agent.state.messages = compacted;
    item.compactions = (item.compactions ?? 0) + 1; this.state.save();
    return compacted;
  }
  // Like Codex's subagent notification: a finished child tells its parent without starting a
  // turn, so the parent learns the outcome at its next request instead of polling. A parent
  // already waiting on the thread gets the outcome from wait_agents instead.
  notifyParent(item, live) {
    if (this.closed || live.quiet || !['completed', 'failed', 'interrupted'].includes(item.status) || this.edges.get(item.parent)?.has(item.id)) return;
    const header = JSON.stringify({ id: item.id, ...(item.nickname ? { nickname: item.nickname } : {}), status: item.status, ...(item.error ? { error: clip(item.error, 900) } : {}) });
    const text = `<subagent_notification>\n${header}${item.output ? '\n' + clip(item.output, this.config.outputBytes) : ''}\n</subagent_notification>`;
    if (item.parent === 'root') this.notify?.(text);
    else this.inject(item.parent, { role: 'custom', customType: 'pi-codex-agent-notification', content: text, display: true, timestamp: Date.now() });
  }
  // A message reaches the model only through the live agent's state; the session file alone is
  // what the next rebuild reads. Both are kept in step so an idle or resumed thread sees it.
  inject(threadId, message) {
    const live = this.live.get(threadId), item = this.state.data.threads[threadId];
    if (!live || !item || item.status === 'closed') return false;
    if (live.agent?.state.isStreaming) { live.agent.steer(message); return true; }
    live.sessionManager.appendMessage(message);
    if (live.agent) live.agent.state.messages = [...live.agent.state.messages, message];
    return true;
  }
  context(threadId) {
    const live = this.live.get(threadId); const item = this.state.data.threads[threadId];
    if (!live) throw Error('Agent thread is not live');
    return { ...live.context, sessionManager: live.sessionManager, model: item.model, thinkingLevel: item.thinkingLevel, signal: live.controller.signal, getSystemPrompt: () => live.systemPrompt };
  }
  send(owner, threadId, message, { steer = false } = {}) {
    threadId = this.resolve(threadId);
    if (!this.state.data.threads[threadId]) throw Error('Unknown agent thread');
    if (owner !== 'root' && !this.owns(owner, threadId) && this.state.data.threads[owner]?.parent !== threadId) throw Error('Messages may target your parent or descendants');
    const item = this.state.data.threads[threadId];
    if (item.status === 'closed') throw Error('Agent thread is closed');
    const event = { sequence: ++this.sequence, from: owner, message, steer, timestamp: Date.now() };
    item.mailbox.push(event); if (item.mailbox.length > 20) item.mailbox = item.mailbox.slice(-20);
    this.state.save();
    const live = this.live.get(threadId);
    const entry = { role: 'user', content: [{ type: 'text', text: `[${this.nickname(owner)} #${event.sequence}] ${message}` }], timestamp: event.timestamp };
    // An idle thread keeps the message in its history for the next resume, without starting a turn.
    if (live?.agent?.state.isStreaming) live.agent[steer ? 'steer' : 'followUp'](entry);
    else if (live) this.inject(threadId, entry);
    return event;
  }
  deliver(threadId, event) {
    const item = this.state.data.threads[threadId]; const live = this.live.get(threadId);
    if (!item || item.status === 'closed' || event.status !== 'answered') return;
    const streaming = live?.agent?.state.isStreaming;
    if (!this.inject(threadId, { role: 'custom', customType: 'pi-codex-user-input', content: JSON.stringify(event), display: true, timestamp: Date.now() }) || streaming) return;
    if (terminal(item.status) || item.status === 'waiting_input') live.run.finally(() => {
      if (!this.closed && item.status !== 'closed') this.resume('root', threadId, 'Continue using the explicit user input event in this thread.');
    });
  }
  hasPath(from, target, visited = new Set()) {
    if (from === target) return true; if (visited.has(from)) return false; visited.add(from);
    return [...(this.edges.get(from) ?? [])].some(next => this.hasPath(next, target, visited));
  }
  async wait(owner, ids, { timeoutMs = 30000, signal, hasInput } = {}) {
    if (!ids.length) throw Error('Select at least one thread');
    const targets = ids.map(target => this.resolve(target));
    for (const target of targets) { this.view(target); if (this.hasPath(target, owner)) throw Error('Agent wait cycle detected'); }
    const prior = this.edges.get(owner) ?? new Set();
    this.edges.set(owner, new Set([...prior, ...targets]));
    const item = this.state.data.threads[owner]; const oldStatus = item?.status;
    if (item) item.status = 'waiting';
    let timer, abort, steered = false;
    const input = whenInput(hasInput, signal);
    try {
      const all = Promise.all(targets.map(target => this.live.get(target)?.settled.promise ?? Promise.resolve(this.view(target))));
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); });
      const cancelled = new Promise((_, reject) => { abort = () => reject(Error('Agent wait cancelled')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
      await this.scheduler.pause(owner, Promise.race([all, deadline, cancelled, input.promise.then(() => { steered = true; })]), signal);
      // Codex WaitResult shape: a compact status map plus bounded outputs of
      // finished threads instead of full thread views with their mailboxes.
      const views = targets.map(target => this.view(target));
      const finished = views.filter(view => terminal(view.status) && view.output);
      // The outputs share one result, so each gets an equal part; head and tail both survive.
      const share = Math.floor(this.config.outputBytes * 0.9 / Math.max(1, finished.length));
      const outputs = Object.fromEntries(finished.map(view => [view.id, clip(view.output, share)]));
      const pending = views.some(view => !terminal(view.status));
      return { status: Object.fromEntries(views.map(view => [view.id, view.status])), timed_out: pending && !steered, ...(pending && steered ? { interrupted_by_input: true } : {}), ...(finished.length ? { outputs } : {}) };
    } finally { clearTimeout(timer); input.stop(); signal?.removeEventListener('abort', abort); this.edges.set(owner, prior); if (item && item.status === 'waiting') item.status = oldStatus; }
  }
  async interrupt(owner, threadId, close = false) {
    threadId = this.resolve(threadId);
    this.assertOwns(owner, threadId); const item = this.state.data.threads[threadId]; if (!item) throw Error('Unknown agent');
    const live = this.live.get(threadId);
    if (live) live.quiet = true;
    live?.controller?.abort(); live?.agent?.abort(); this.scheduler.cancel(threadId); this.questions.cancelOwner(threadId);
    await this.executor.cancelOwner(threadId); if (live) await live.run;
    item.status = close ? 'closed' : 'interrupted';
    if (close) for (const child of Object.values(this.state.data.threads).filter(x => x.parent === threadId && x.status !== 'closed')) await this.interrupt(owner, child.id, true);
    this.state.save(); this.onChange(); return this.view(threadId);
  }
  resume(owner, threadId, message = 'Continue the assigned task.') {
    if (this.closed) throw Error('Thread manager is closed');
    threadId = this.resolve(threadId);
    this.assertOwns(owner, threadId); const item = this.state.data.threads[threadId];
    if (!terminal(item.status) && item.status !== 'idle' && item.status !== 'waiting_input') throw Error('Agent is already running');
    let live = this.live.get(threadId);
    if (!live) {
      const context = this.getContext(owner);
      const sessionManager = SessionManager.open(item.sessionFile);
      live = { context, sessionManager, systemPrompt: context.getSystemPrompt() }; this.live.set(threadId, live);
    }
    live.controller = new AbortController(); live.settled = deferred(); live.quiet = false; item.status = 'queued';
    live.run = this.run(item, live, message); this.state.save(); return this.view(threadId);
  }
  async compact(owner, threadId, instructions, signal) {
    threadId = this.resolve(threadId);
    this.assertOwns(owner, threadId); const item = this.state.data.threads[threadId];
    if (!item || !terminal(item.status) && item.status !== 'idle') throw Error('Only an idle or completed thread can be compacted');
    let live = this.live.get(threadId);
    if (!live) { const context = this.getContext(owner); live = { context, sessionManager: SessionManager.open(item.sessionFile), systemPrompt: context.getSystemPrompt() }; this.live.set(threadId, live); }
    const messages = live.sessionManager.buildSessionContext().messages;
    const stateSummary = this.state.continuity();
    const summary = await generateSummaryWithUsage(messages, item.model, undefined, undefined, undefined, signal,
      `${instructions ?? 'Preserve the task, concrete decisions, unresolved questions, code changes, verification limits and agent thread references.'}\nDurable state: ${JSON.stringify(stateSummary)}`,
      undefined, item.thinkingLevel, (model, context, options) => live.context.modelRegistry.streamSimple(model, context, options), undefined, undefined, undefined, live.sessionManager.getSessionId());
    live.sessionManager.appendCompaction(summary.text, null, messages.reduce((sum, message) => sum + estimateTokens(message), 0), { piCodex: stateSummary }, true, summary.usage);
    live.agent = undefined; this.state.save();
    return { id: threadId, compacted: true, summary: summary.text, usage: summary.usage };
  }
  restore() {
    for (const item of Object.values(this.state.data.threads)) {
      if (!terminal(item.status)) item.status = 'idle';
      const match = /^(\w+)-(\d+)$/.exec(item.nickname ?? '');
      if (match) this.roleCounts.set(match[1], Math.max(this.roleCounts.get(match[1]) ?? 0, Number(match[2])));
    }
    this.sequence = Math.max(0, ...Object.values(this.state.data.threads).flatMap(t => t.mailbox.map(m => m.sequence)));
    this.state.save();
  }
  async close() { this.closed = true; for (const item of Object.values(this.state.data.threads)) if (this.live.has(item.id) && item.status !== 'closed') await this.interrupt('root', item.id, true); }
}
