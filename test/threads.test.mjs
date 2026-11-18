import test from 'node:test';
import assert from 'node:assert/strict';
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
