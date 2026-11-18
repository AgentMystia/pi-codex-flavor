import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, pause, callTool, lastText } from './helpers.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { deferred } from '../src/util.mjs';
import { readSubagentConfig, subagentsPath, supportedThinkingLevels, writeSubagentConfig } from '../src/subagents.mjs';
test('subagent thinking levels include max and respect model support metadata', () => {
  assert.deepEqual(supportedThinkingLevels(), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(supportedThinkingLevels({ thinkingLevelMap: { max: 'max' } }), ['off', 'max']);
});
test('subagent model resolution prefers session over global over inherit and stays memory-only at the session layer', async t => {
  const f = await fixture(t, { handler: () => 'done' });
  const inherited = f.runtime.threads.spawn('root', { message: 'inherit' }); await f.runtime.threads.live.get(inherited.id).run;
  let item = f.runtime.threads.view(inherited.id);
  assert.equal(item.modelSource, 'inherit'); assert.equal(item.model.id, 'mock-code'); assert.equal(item.thinkingLevel, 'high');
  await writeSubagentConfig(subagentsPath(f.agentDir), { model: { provider: 'mock', id: 'mock-code' }, thinking: 'low' });
  await f.runtime.reloadSubagentGlobal();
  item = f.runtime.threads.view(f.runtime.threads.spawn('root', { message: 'global' }).id);
  assert.equal(item.modelSource, 'global'); assert.equal(item.thinkingLevel, 'low');
  f.runtime.subagentSession = { model: null, thinking: 'max' };
  item = f.runtime.threads.view(f.runtime.threads.spawn('root', { message: 'session' }).id);
  assert.equal(item.modelSource, 'session'); assert.equal(item.thinkingLevel, 'max'); assert.equal(item.model.id, 'mock-code');
  f.runtime.subagentSession = { model: { provider: 'other', id: 'unavailable' }, thinking: null };
  item = f.runtime.threads.view(f.runtime.threads.spawn('root', { message: 'fallback' }).id);
  assert.equal(item.modelSource, 'session'); assert.equal(item.model.id, 'mock-code'); assert.match(item.modelNote, /unavailable; inherited/);
  assert.deepEqual(await readSubagentConfig(subagentsPath(f.agentDir)), { model: { provider: 'mock', id: 'mock-code' }, thinking: 'low' }, 'the global file is untouched by session overrides');
  assert.equal(JSON.stringify(f.persisted).includes('subagentSession'), false, 'the session layer is never written to the session file');
  const reviewer = f.runtime.threads.view(f.runtime.threads.spawn('root', { message: 'review', role: 'reviewer' }).id);
  assert.equal(reviewer.readOnly, true, 'reviewer stays read-only regardless of configured model');
});
test('agents get role nicknames and wait returns the compact Codex WaitResult shape', async t => {
  const f = await fixture(t, { handler: () => 'scout findings' });
  const spawn = f.runtime.threads.spawn('root', { message: 'scout job', role: 'scout' });
  assert.equal(spawn.nickname, 'scout-1');
  assert.equal(f.runtime.threads.resolve('scout-1'), spawn.id);
  const worker = f.runtime.threads.spawn('root', { message: 'worker job' });
  assert.equal(worker.nickname, 'worker-1');
  await f.runtime.threads.live.get(spawn.id).run;
  const waited = await f.runtime.threads.wait('root', ['scout-1']);
  assert.deepEqual(waited, { status: { [spawn.id]: 'completed' }, timed_out: false, outputs: { [spawn.id]: 'scout findings' } });
  f.runtime.threads.send('root', worker.nickname, 'by nickname');
  assert.deepEqual(f.runtime.threads.view(worker.id).mailbox.map(event => event.message), ['by nickname']);
  const toolSpawn = await f.call('spawn_agent', { message: 'second scout', role: 'scout' });
  assert.deepEqual(Object.keys(JSON.parse(toolSpawn.content[0].text)), ['id', 'nickname', 'status', 'parent'], 'spawn results stay compact');
  assert.equal(JSON.parse(toolSpawn.content[0].text).nickname, 'scout-2');
  const listed = await f.call('list_agents', {});
  assert.ok(listed.details.threads.some(thread => thread.nickname === 'scout-1' && thread.modelSource === 'inherit'));
  assert.ok(listed.details.threads.every(thread => !('mailbox' in thread) && !('output' in thread) && !('model' in thread)), 'list_agents strips mailboxes, outputs and full models');
  assert.throws(() => f.runtime.threads.resolve('ghost'), /Unknown agent thread: ghost/);
});
for (const concurrency of [16, 64]) test(`256 agent tasks obey ${concurrency} execution slots and fair FIFO queuing`, async t => {
  let active = 0, peak = 0; const order = [];
  const f = await fixture(t, { config: { concurrency }, handler: async context => {
    peak = Math.max(peak, ++active); order.push(lastText(context)); await pause(2); active--; return 'complete';
  } });
  const threads = Array.from({ length: 256 }, (_, index) => f.runtime.threads.spawn('root', { message: `task ${index}` }));
  await Promise.all(threads.map(thread => f.runtime.threads.live.get(thread.id).run));
  assert.equal(peak, concurrency); assert.deepEqual(order, Array.from({ length: 256 }, (_, index) => `task ${index}`));
  assert.ok(threads.every(thread => f.runtime.threads.view(thread.id).status === 'completed'));
  assert.equal(f.runtime.scheduler.snapshot().active.length, 0);
});
test('four layers of nested delegation complete with one execution slot', async t => {
  const f = await fixture(t, { config: { concurrency: 1 }, handler: async context => {
    const last = context.messages.at(-1);
    if (last.role === 'toolResult') {
      if (last.toolName === 'spawn_agent') return callTool('wait_agents', { ids: [JSON.parse(lastText(context)).id], timeout_ms: 1000 }, 'wait');
      return 'nested done';
    }
    const depth = Number(/depth (\d+)/.exec(lastText(context))?.[1]);
    return depth < 4 ? callTool('spawn_agent', { message: `depth ${depth + 1}` }, 'spawn') : 'leaf';
  } });
  const first = f.runtime.threads.spawn('root', { message: 'depth 1' });
  await f.runtime.threads.live.get(first.id).run;
  assert.equal(Object.keys(f.runtime.state.data.threads).length, 4);
  assert.ok(Object.values(f.runtime.state.data.threads).every(thread => thread.status === 'completed'));
  const leaf = Object.values(f.runtime.state.data.threads).find(thread => thread.depth === 4);
  assert.throws(() => f.runtime.threads.spawn(leaf.id, { message: 'fifth' }), /depth/);
});
test('wait cycles are rejected and sibling waits are allowed', async t => {
  const f = await fixture(t); const a = f.runtime.threads.spawn('root', { message: 'a' }), b = f.runtime.threads.spawn('root', { message: 'b' });
  f.runtime.threads.edges.set(a.id, new Set([b.id]));
  await assert.rejects(f.runtime.threads.wait(b.id, [a.id]), /cycle/);
  const waited = await f.runtime.threads.wait('root', [a.id, b.id]);
  assert.deepEqual(Object.values(waited.status), ['completed', 'completed']);
  assert.equal(waited.timed_out, false);
});
test('sync child questions forward through root dialogs and release execution capacity', async t => {
  const answer = deferred();
  const f = await fixture(t, { config: { concurrency: 1 }, ui: { available: true, input: async () => answer.promise }, handler: async context => context.messages.at(-1).role === 'toolResult' ? 'answered' : callTool('request_user_input', { questions: [{ title: '需求是什么？' }] }) });
  const child = f.runtime.threads.spawn('root', { message: 'ask' }); await pause(10);
  assert.equal(f.runtime.scheduler.active.size, 0); assert.equal(f.runtime.scheduler.paused.has(child.id), true);
  answer.resolve('明确需求'); await f.runtime.threads.live.get(child.id).run;
  assert.equal(f.runtime.state.data.decisions[0].owner, child.id); assert.equal(f.runtime.threads.view(child.id).output, 'answered');
});
test('async child questions can settle then resume the persistent thread on an explicit answer', async t => {
  const answer = deferred(); let turns = 0;
  const f = await fixture(t, { ui: { available: true, input: async () => answer.promise }, handler: async context => {
    turns++;
    if (turns === 1) return callTool('request_user_input_async', { questions: [{ title: 'Proceed with which name?' }] });
    return lastText(context).includes('Continue using') ? 'resumed with answer' : 'independent work complete';
  } });
  const child = f.runtime.threads.spawn('root', { message: 'ask async' }); await f.runtime.threads.live.get(child.id).run;
  assert.equal(f.runtime.threads.view(child.id).status, 'waiting_input'); assert.equal(f.runtime.scheduler.active.size, 0);
  answer.resolve('chosen'); await f.runtime.dialogs.tail; await pause(20); await f.runtime.threads.live.get(child.id).run;
  assert.equal(f.runtime.threads.view(child.id).status, 'completed'); assert.equal(f.runtime.threads.view(child.id).output, 'resumed with answer');
});
test('a resumed child sees the answer to its async question and earlier messages sent while it was idle', async t => {
  const answer = deferred(); let turns = 0, resumedContext = '', followUpContext = '';
  const f = await fixture(t, { ui: { available: true, input: async () => answer.promise }, handler: async context => {
    turns++;
    if (turns === 1) return callTool('request_user_input_async', { questions: [{ title: 'Proceed with which name?' }] });
    if (lastText(context).includes('Continue using')) { resumedContext = JSON.stringify(context.messages); return 'resumed'; }
    if (lastText(context).includes('What was the word')) { followUpContext = JSON.stringify(context.messages); return 'pelican'; }
    return 'independent work complete';
  } });
  const child = f.runtime.threads.spawn('root', { message: 'ask async' }); await f.runtime.threads.live.get(child.id).run;
  answer.resolve('chosen-name'); await f.runtime.dialogs.tail; await pause(20); await f.runtime.threads.live.get(child.id).run;
  assert.match(resumedContext, /chosen-name/, 'the answer reaches the live agent, not only the session file');
  f.runtime.threads.send('root', child.id, 'the code word is pelican');
  f.runtime.threads.resume('root', child.id, 'What was the word?'); await f.runtime.threads.live.get(child.id).run;
  assert.match(followUpContext, /the code word is pelican/);
  assert.equal(f.runtime.threads.view(child.id).output, 'pelican');
});
test('a finished child notifies its parent unless the parent is waiting on it or stopped it', async t => {
  const notices = [];
  const f = await fixture(t, { handler: async context => { if (lastText(context).includes('slow')) await pause(300); return `result for ${lastText(context)}`; } });
  f.runtime.agentNotice = text => notices.push(text);
  const loose = f.runtime.threads.spawn('root', { message: 'loose job' }); await f.runtime.threads.live.get(loose.id).run;
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^<subagent_notification>\n\{"id":"agent_\w+","nickname":"worker-1","status":"completed"\}\nresult for loose job\n<\/subagent_notification>$/);
  const awaited = f.runtime.threads.spawn('root', { message: 'awaited job' });
  assert.equal((await f.runtime.threads.wait('root', [awaited.id])).outputs[awaited.id], 'result for awaited job');
  const stopped = f.runtime.threads.spawn('root', { message: 'slow job' }); await pause(20);
  await f.runtime.threads.interrupt('root', stopped.id);
  assert.equal(notices.length, 1, 'neither a waited-on nor an interrupted thread adds a notification');
  const nested = await fixture(t, { handler: async context => {
    if (lastText(context).includes('inner task')) return 'inner done';
    return context.messages.some(message => message.role === 'toolResult') ? 'outer saw the notification' : callTool('spawn_agent', { message: 'inner task' });
  } });
  const outer = nested.runtime.threads.spawn('root', { message: 'outer task' }); await nested.runtime.threads.live.get(outer.id).run;
  const inner = Object.values(nested.runtime.state.data.threads).find(thread => thread.parent === outer.id);
  await nested.runtime.threads.live.get(inner.id).run;
  const history = JSON.stringify(nested.runtime.threads.live.get(outer.id).sessionManager.buildSessionContext().messages);
  assert.match(history, /subagent_notification[^]*inner done/, 'a child thread parent gets the notification in its own history');
});
test('wait ends early on new input and splits its output budget across finished threads', async t => {
  const f = await fixture(t, { config: { outputBytes: 24000 }, handler: async context => {
    if (lastText(context).includes('slow')) { await pause(2000); return 'late'; }
    return `${'x'.repeat(30000)}TAIL-${lastText(context)}`;
  } });
  const slow = f.runtime.threads.spawn('root', { message: 'slow' });
  const started = Date.now();
  const steered = await f.runtime.threads.wait('root', [slow.id], { timeoutMs: 10000, hasInput: () => true });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual({ timed_out: steered.timed_out, interrupted_by_input: steered.interrupted_by_input }, { timed_out: false, interrupted_by_input: true });
  const jobs = ['a', 'b', 'c'].map(name => f.runtime.threads.spawn('root', { message: name }));
  const waited = await f.runtime.threads.wait('root', jobs.map(job => job.id));
  for (const [index, job] of jobs.entries()) {
    const output = waited.outputs[job.id];
    assert.ok(Buffer.byteLength(output) < 7300, 'each output gets a third of the budget');
    assert.ok(output.endsWith(`TAIL-${['a', 'b', 'c'][index]}`), 'the tail of every output survives');
  }
});
test('a long child thread compacts itself before reaching the context window and keeps working', async t => {
  const summaries = []; let reads = 0;
  const f = await fixture(t, { handler: async context => {
    const text = JSON.stringify(context);
    if (text.includes('context summarization assistant')) { summaries.push(text); return 'SUMMARY-OF-EARLIER-WORK'; }
    const usage = { input: Math.ceil(Buffer.byteLength(text) / 4), output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: Math.ceil(Buffer.byteLength(text) / 4) + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    if (reads < 4) return { content: callTool('read', { path: 'big.txt' }, `read_${++reads}`), extra: { usage } };
    return { content: [{ type: 'text', text: 'finished after compaction' }], extra: { usage } };
  } });
  await writeFile(path.join(f.root, 'big.txt'), 'line of data\n'.repeat(700));
  f.context.model = { ...f.context.model, contextWindow: 8000 };
  const child = f.runtime.threads.spawn('root', { message: 'read the file four times' }); await f.runtime.threads.live.get(child.id).run;
  const item = f.runtime.threads.view(child.id);
  assert.equal(item.status, 'completed'); assert.equal(item.output, 'finished after compaction');
  assert.ok(summaries.length >= 1 && item.compactions >= 1);
  assert.match(summaries[0], /read the file four times/, 'the assignment is part of the summary request');
  const session = f.runtime.threads.live.get(child.id).sessionManager;
  assert.ok(session.getBranch().some(entry => entry.type === 'compaction'));
  const context = session.buildSessionContext().messages;
  assert.equal(context[0].role, 'compactionSummary');
  assert.ok(context.some(message => message.role === 'toolResult'), 'the most recent work stays verbatim');
});
test('a child thread recovers from a context overflow by compacting once', async t => {
  let calls = 0, overflowed = false;
  const f = await fixture(t, { handler: async context => {
    const text = JSON.stringify(context);
    if (text.includes('context summarization assistant')) return 'SUMMARY';
    calls++;
    if (calls <= 3) return callTool('read', { path: 'big.txt' }, `read_${calls}`);
    if (!overflowed) { overflowed = true; throw Error('prompt is too long: 9000 tokens > 8000 maximum'); }
    return 'recovered';
  } });
  await writeFile(path.join(f.root, 'big.txt'), 'line of data\n'.repeat(700));
  f.context.model = { ...f.context.model, contextWindow: 8000 };
  const child = f.runtime.threads.spawn('root', { message: 'work' }); await f.runtime.threads.live.get(child.id).run;
  const item = f.runtime.threads.view(child.id);
  assert.equal(item.status, 'completed'); assert.equal(item.output, 'recovered'); assert.equal(item.compactions, 1);
  const history = f.runtime.threads.live.get(child.id).sessionManager.buildSessionContext().messages;
  assert.equal(history.filter(message => message.stopReason === 'error').length, 0, 'the overflowed attempt stays out of history');
});
test('messages keep order; closed threads invalidate pending input and reject late execution', async t => {
  const f = await fixture(t, { handler: async () => { await pause(20); return 'done'; } });
  const child = f.runtime.threads.spawn('root', { message: 'wait' });
  const a = f.runtime.threads.send('root', child.id, 'first'), b = f.runtime.threads.send('root', child.id, 'second', { steer: true });
  assert.ok(a.sequence < b.sequence); assert.deepEqual(f.runtime.threads.view(child.id).mailbox.map(x => x.message), ['first', 'second']);
  await f.runtime.threads.interrupt('root', child.id, true); assert.equal(f.runtime.threads.view(child.id).status, 'closed');
  assert.throws(() => f.runtime.threads.send('root', child.id, 'late'), /closed/);
  assert.equal(f.runtime.scheduler.active.size, 0);
});
test('scheduler cancellation and concurrent waits do not lose or duplicate slots', async () => {
  const scheduler = new Scheduler(1); await scheduler.acquire('a');
  const controller = new AbortController(); const waiting = scheduler.acquire('b', controller.signal); controller.abort(); await assert.rejects(waiting, /cancelled/);
  const first = deferred(), second = deferred();
  const pa = scheduler.pause('a', first.promise), pb = scheduler.pause('a', second.promise);
  first.resolve(); await pa; assert.equal(scheduler.active.size, 0);
  second.resolve(); await pb; assert.deepEqual([...scheduler.active], ['a']); scheduler.release('a');
});
test('idle thread compaction reuses Pi summary and preserves explicit continuity state', async t => {
  const f = await fixture(t, { handler: () => 'A useful compact summary' });
  const child = f.runtime.threads.spawn('root', { message: 'Task to continue' }); await f.runtime.threads.live.get(child.id).run;
  const response = await f.runtime.threads.compact('root', child.id, 'Preserve decisions'); assert.equal(response.compacted, true);
  const live = f.runtime.threads.live.get(child.id); assert.equal(live.agent, undefined);
  assert.ok(live.sessionManager.getBranch().some(entry => entry.type === 'compaction'));
  f.runtime.threads.resume('root', child.id, 'Continue'); await live.run; assert.equal(f.runtime.threads.view(child.id).status, 'completed');
});
test('a child thread retries a temporary provider failure and keeps the failed attempt out of its history', async t => {
  let calls = 0;
  const f = await fixture(t, { handler: () => { if (++calls === 1) throw Error('429 rate limit reached'); return 'recovered'; } });
  f.runtime.threads.retryDelayMs = 1;
  const child = f.runtime.threads.spawn('root', { message: 'work' });
  const waited = await f.runtime.threads.wait('root', [child.id], { timeoutMs: 5000 });
  assert.equal(waited.status[child.id], 'completed'); assert.equal(waited.outputs[child.id], 'recovered'); assert.equal(calls, 2);
  assert.equal(f.runtime.threads.view(child.id).retries, 1);
  const history = f.runtime.threads.live.get(child.id).sessionManager.buildSessionContext().messages;
  assert.equal(history.filter(message => message.stopReason === 'error').length, 0);
  let attempts = 0;
  const final = await fixture(t, { handler: () => { attempts++; throw Error('insufficient_quota (429)'); } });
  final.runtime.threads.retryDelayMs = 1;
  const refused = final.runtime.threads.spawn('root', { message: 'work' });
  const outcome = await final.runtime.threads.wait('root', [refused.id], { timeoutMs: 5000 });
  assert.equal(outcome.status[refused.id], 'failed'); assert.equal(attempts, 1, 'a quota reply is final');
});
