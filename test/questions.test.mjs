import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pause } from './helpers.mjs';
import { deferred } from '../src/util.mjs';
import { State, STATE_TYPE } from '../src/state.mjs';
test('sync questions serialize options, explanations and free input without granting approval', async t => {
  const calls = []; const choices = ['使用本地 (Recommended) — 无服务依赖', '自由输入 / Free text'];
  const f = await fixture(t, { ui: { available: true, select: async (title, options) => { calls.push({ title, options }); return choices.shift(); }, input: async () => '用户决定', confirm: async () => { throw Error('Question must never call confirm'); } } });
  await f.runtime.scheduler.acquire('root');
  const response = await f.runtime.questions.request('root', [{ id: 'storage', question: '存储？', options: [{ label: '使用本地 (Recommended)', description: '无服务依赖' }, { label: '远程', description: '共享' }] }, { id: 'name', question: '名称？', options: ['甲', '乙'] }]);
  assert.equal(response.status, 'answered'); assert.equal(response.answers.name.answers[0], '用户决定');
  assert.match(calls[0].title, /root/); assert.equal(f.runtime.state.data.approvals.length, 0); assert.equal(f.runtime.state.data.decisions.length, 1);
  assert.deepEqual(f.runtime.scheduler.snapshot().active, ['root']);
});
test('async returns immediately; independent work can continue; concurrent questions have one dialog', async t => {
  const first = deferred(); let active = 0, peak = 0; const f = await fixture(t, { ui: { available: true, input: async () => { peak = Math.max(peak, ++active); await first.promise; active--; return 'answer'; } } });
  const a = f.runtime.questions.request('root', [{ title: 'First' }], { async: true });
  const b = f.runtime.questions.request('child', [{ title: 'Second' }], { async: true });
  assert.equal(a.status, 'pending'); assert.notEqual(a.request_id, b.request_id);
  await pause(5); assert.equal(f.runtime.state.data.questions[a.request_id].status, 'pending');
  first.resolve(); await f.runtime.dialogs.tail;
  assert.equal(peak, 1); assert.equal(f.events[0].request_id, a.request_id);
  assert.equal(f.runtime.state.data.questions[b.request_id].status, 'answered');
});
test('cancel, expiry and closed owners cannot deliver late answers or approve execution', async t => {
  const input = deferred(); const f = await fixture(t, { ui: { available: true, input: async () => input.promise } });
  const q = f.runtime.questions.request('child', [{ title: 'Delayed' }], { async: true });
  await pause(1); f.runtime.questions.cancelOwner('child'); input.resolve('yes'); await f.runtime.dialogs.tail;
  assert.equal(f.runtime.state.data.questions[q.request_id].status, 'invalidated');
  assert.throws(() => f.runtime.questions.answer(q.request_id, { q1: { answers: ['yes'] } }), /no longer pending/);
  assert.equal(f.runtime.state.data.decisions.length, 0); assert.equal(f.runtime.state.data.approvals.length, 0);
  const g = await fixture(t, { ui: { available: true, input: async (_title, _placeholder, opts) => new Promise(resolve => opts.signal.addEventListener('abort', () => resolve(undefined), { once: true })) } });
  const timeout = await g.runtime.questions.request('root', [{ title: 'Expires' }], { timeoutMs: 10 });
  assert.equal(timeout.status, 'expired');
});
test('missing channel is unavailable; restored questions retain records but cannot resurrect execution', async t => {
  const f = await fixture(t);
  assert.equal(f.runtime.questions.request('root', [{ title: 'No UI' }]).status, 'unavailable');
  f.runtime.state.data.questions.q = { id: 'q', owner: 'root', questions: [{ id: 'x', question: 'Question' }], status: 'pending' }; f.runtime.state.save();
  const restored = new State(() => {}, f.persisted);
  assert.equal(restored.data.questions.q.status, 'pending'); f.runtime.state = restored;
  f.runtime.questions.state = restored; f.runtime.questions.invalidateRestored();
  assert.equal(restored.data.questions.q.status, 'invalidated');
  assert.equal(f.persisted.at(-1).customType, STATE_TYPE);
});
test('explicit decision cannot satisfy an execution approval', async t => {
  const f = await fixture(t, { config: { approval: 'always' }, ui: { available: true, input: async () => 'yes', select: async () => undefined } });
  await f.runtime.questions.request('root', [{ title: 'Preference' }]);
  await assert.rejects(f.call('write', { path: 'file', content: 'no' }), /denied/);
  assert.equal(f.runtime.state.data.decisions.length, 1); assert.equal(f.runtime.state.data.approvals[0].status, 'denied');
});
