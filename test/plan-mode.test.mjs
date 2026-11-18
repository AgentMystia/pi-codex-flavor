import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, pause, sessionFixture } from './helpers.mjs';
import { extractProposedPlan, planSelectionItems, planUsageLabel, PLAN_IMPLEMENTATION_TITLE, PLAN_IMPLEMENTATION_YES, PLAN_IMPLEMENTATION_CLEAR_CONTEXT, PLAN_IMPLEMENTATION_NO, PLAN_IMPLEMENTATION_CODING_MESSAGE } from '../src/plan.mjs';
import { modeInstructions, PLAN_MODE_PROMPT, DEFAULT_MODE_PROMPT } from '../src/prompt.mjs';
import { State } from '../src/state.mjs';

test('extractProposedPlan mirrors the Codex tagged-line parser', () => {
  assert.equal(extractProposedPlan('before\n<proposed_plan>\n- step\n</proposed_plan>\nafter'), '- step\n');
  assert.equal(extractProposedPlan('<proposed_plan>\n- step\n  </proposed_plan>\n'), '- step\n', 'tags tolerate surrounding whitespace');
  assert.equal(extractProposedPlan('  <proposed_plan> extra\n'), null, 'a tag line with extra text is normal text');
  assert.equal(extractProposedPlan('<prop\nosed_plan>\n- step 1\n</proposed_plan>\nOutro'), null, 'a tag broken by a newline is not a tag; complete text never sees chunk splits');
  assert.equal(extractProposedPlan('<proposed_plan>\n- step\n'), '- step\n', 'an unterminated block closes at the end');
  assert.equal(extractProposedPlan('<proposed_plan>\nfirst\n</proposed_plan>\nmid\n<proposed_plan>\nsecond\n</proposed_plan>\n'), 'second\n', 'the last block wins');
  assert.equal(extractProposedPlan('<proposed_plan>\n</proposed_plan>\n'), '', 'an empty block is extracted as empty text');
  assert.equal(extractProposedPlan('no tags here'), null);
  assert.equal(extractProposedPlan('talk\n<proposed_plan>\nunchanged\n</proposed_plan>'), 'unchanged\n', 'missing trailing newline is preserved without adding one');
});

test('plan selection items carry the verbatim Codex copy and disabled rules', () => {
  const items = planSelectionItems({ planMarkdown: '- Step\n' });
  assert.deepEqual(items.map(item => item.name), [PLAN_IMPLEMENTATION_YES, PLAN_IMPLEMENTATION_CLEAR_CONTEXT, PLAN_IMPLEMENTATION_NO]);
  assert.equal(items[0].description, 'Switch to Default and start coding');
  assert.equal(items[2].description, 'Continue planning with the model');
  assert.equal(items.every(item => !item.disabled), true);

  const usage = planSelectionItems({ planMarkdown: '- Step\n', usageLabel: '89% used' });
  assert.equal(usage[1].description, 'Start a fresh thread (current context: 89% used)');
  const fresh = planSelectionItems({ planMarkdown: '- Step\n' });
  assert.equal(fresh[1].description, 'Fresh thread with this plan');

  for (const planMarkdown of [undefined, null, '', '  \n']) {
    const cleared = planSelectionItems({ planMarkdown });
    assert.equal(cleared[1].disabled?.reason, 'No approved plan available', `plan ${JSON.stringify(planMarkdown)} disables clear-context`);
  }
  const unavailable = planSelectionItems({ planMarkdown: '- Step\n', defaultModeUnavailable: true });
  assert.equal(unavailable[0].disabled?.reason, 'Default mode unavailable');
  assert.equal(unavailable[1].disabled?.reason, 'Default mode unavailable');
  assert.equal(PLAN_IMPLEMENTATION_TITLE, 'Implement this plan?');
  assert.equal(PLAN_IMPLEMENTATION_CODING_MESSAGE, 'Implement the plan.');
});

test('plan usage label reports the used share with Codex rounding', () => {
  assert.equal(planUsageLabel({ percent: 89, tokens: null, contextWindow: 100 }), '89% used', 'Pi percent is already the used share');
  assert.equal(planUsageLabel({ percent: 88.6, tokens: null, contextWindow: 100 }), '89% used', 'remaining rounds first: 100 - round(11.4) = 89');
  assert.equal(planUsageLabel({ percent: 88.4, tokens: null, contextWindow: 100 }), '88% used', 'remaining rounds first: 100 - round(11.6) = 88');
  assert.equal(planUsageLabel({ percent: 11, tokens: null, contextWindow: 100 }), '11% used', 'the used share is displayed directly, never the remaining share');
  assert.equal(planUsageLabel({ percent: 100, tokens: null, contextWindow: 100 }), '100% used');
  assert.equal(planUsageLabel({ percent: 0, tokens: null, contextWindow: 100 }), null, 'a fresh context reports nothing');
  assert.equal(planUsageLabel({ percent: null, tokens: 123000, contextWindow: 200000 }), '123K used');
  assert.equal(planUsageLabel({ percent: null, tokens: 999400, contextWindow: 2000000 }), '999K used');
  assert.equal(planUsageLabel({ percent: null, tokens: 999600, contextWindow: 2000000 }), '1M used', '999,500 promotes to 1M');
  assert.equal(planUsageLabel({ percent: null, tokens: 1234567, contextWindow: 4000000 }), '1.23M used');
  assert.equal(planUsageLabel({ percent: null, tokens: 2500000, contextWindow: 4000000 }), '2.5M used');
  assert.equal(planUsageLabel({ percent: null, tokens: 0, contextWindow: 100 }), null);
  assert.equal(planUsageLabel(undefined), null);
});

test('mode instructions wrap the adapted Codex collaboration-mode templates', () => {
  const plan = modeInstructions('plan');
  assert.match(plan, /^<collaboration_mode>\n# Plan Mode \(Conversational\)/);
  assert.match(plan, /<\/collaboration_mode>$/);
  assert.match(plan, /<proposed_plan>/);
  assert.match(plan, /`update_plan` is a checklist\/progress\/TODOs tool/);
  const defaults = modeInstructions('execute');
  assert.match(defaults, /^<collaboration_mode>\n# Collaboration Mode: Default/);
  assert.match(defaults, /no longer active/);
  assert.match(PLAN_MODE_PROMPT, /read-only/);
  assert.ok(DEFAULT_MODE_PROMPT.length > 0);
});

test('update_plan is rejected in Plan mode with the Codex message and works in execute mode', async t => {
  const f = await fixture(t);
  await f.call('update_plan', { plan: [{ step: 'a', status: 'pending' }] });
  f.runtime.state.data.mode = 'plan';
  await assert.rejects(f.call('update_plan', { plan: [{ step: 'b', status: 'pending' }] }), /update_plan is a TODO\/checklist tool and is not allowed in Plan mode/);
  assert.equal(f.runtime.state.data.plan.at(-1).step, 'a');
});

test('request_user_input_async becomes blocking in Plan mode like Codex is_blocking', async t => {
  const asked = [];
  const f = await fixture(t, { ui: { available: true, input: async title => { asked.push(title); return '决定'; } } });
  const immediate = await f.call('request_user_input_async', { questions: [{ title: 'Queue' }] });
  assert.ok(immediate.details.request_id, 'execute mode returns a request id immediately');
  assert.equal(immediate.details.status, 'pending');
  await pause(10);
  assert.equal(f.runtime.state.data.questions[immediate.details.request_id].status, 'answered');
  f.runtime.state.data.mode = 'plan';
  const blocking = await f.call('request_user_input_async', { questions: [{ title: 'Plan asks' }] });
  assert.equal(blocking.details.status, 'answered');
  assert.equal(blocking.details.answers.q1.answers[0], '决定');
  assert.equal(asked.length, 2);
});

test('proposed plans persist in durable state without empty overwrites', () => {
  const state = new State(() => {});
  assert.equal(state.setProposedPlan(''), null);
  const first = state.setProposedPlan('- first\n');
  assert.equal(first.text, '- first\n');
  state.setProposedPlan('  \n');
  assert.equal(state.data.proposedPlan.text, '- first\n');
  const second = state.setProposedPlan('- second\n');
  assert.equal(second.text, '- second\n');
  assert.ok(second.at >= first.at);
});

test('plan mode read-only policy still blocks writes and external tools', async t => {
  const f = await fixture(t, { config: { sandbox: 'none' } });
  f.runtime.state.data.mode = 'plan';
  await assert.rejects(f.call('write', { path: 'out.txt', content: 'x' }), /Read-only mode forbids file changes/);
  await assert.rejects(f.runtime.guardExternal('external_tool', 'root'), /Read-only mode blocks external tools that are not marked read-only/);
  await f.runtime.guardExternal('search_tool', 'root', undefined, true);
  assert.equal(f.runtime.state.data.approvals.length, 0, 'a tool that declares itself read-only runs in Plan Mode without an approval');
});

test('mode instructions survive state round-trips and stay out of the summary bloat', () => {
  const persisted = [];
  const state = new State((type, data) => persisted.push({ customType: type, data }));
  state.data.mode = 'plan'; state.save();
  const restored = new State(() => {}, persisted);
  assert.equal(restored.data.mode, 'plan');
  assert.equal(restored.summary().mode, 'plan');
  assert.equal('proposedPlan' in restored.summary(), false);
});

test('actual /plan toggles modes with tagged collaboration instructions and no model request', async t => {
  const f = await sessionFixture(t, () => 'done');
  await f.session.prompt('/plan');
  assert.equal(f.requests.length, 0, 'toggling modes alone never triggers a model request');
  const branch = () => f.sessionManager.getBranch();
  assert.equal(new State(() => {}, branch()).data.mode, 'plan');
  const planEntry = branch().filter(entry => entry.customType === 'pi-codex-mode').at(-1);
  assert.match(planEntry.data ?? planEntry.content ?? JSON.stringify(planEntry), /<collaboration_mode>/);
  assert.match(JSON.stringify(planEntry), /Plan Mode \(Conversational\)/);
  assert.equal(planEntry.display, false);
  await f.session.prompt('/plan');
  assert.equal(new State(() => {}, branch()).data.mode, 'execute');
  const defaultEntry = branch().filter(entry => entry.customType === 'pi-codex-mode').at(-1);
  assert.match(JSON.stringify(defaultEntry), /Collaboration Mode: Default/);
  await f.session.prompt('Continue');
  assert.equal(f.requests.length, 1);
  assert.match(JSON.stringify(f.requests.at(-1)), /Collaboration Mode: Default/);
});

test('actual /plan <text> enters Plan mode and submits the text once', async t => {
  const f = await sessionFixture(t, () => 'planned');
  await f.session.prompt('/plan 规划重构');
  for (let i = 0; i < 50 && f.requests.length < 1; i++) await pause(20);
  assert.equal(f.requests.length, 1);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.mode, 'plan');
  const messages = f.requests[0].messages;
  assert.equal(messages.find(m => m.role === 'user' && JSON.stringify(m.content).includes('规划重构')) !== undefined, true);
  assert.match(JSON.stringify(messages), /Plan Mode \(Conversational\)/);
});

test('actual picker after a proposed plan implements in place like Codex option 1', async t => {
  let turn = 0;
  const f = await sessionFixture(t, () => ++turn === 1
    ? 'Here is my plan.\n<proposed_plan>\n# Plan\n- do it\n</proposed_plan>'
    : 'implemented');
  await f.session.bindExtensions({ mode: 'rpc', uiContext: {
    select: async (_title, choices) => choices[0], input: async () => '', confirm: async () => false, notify() {}, setStatus() {}, setWidget() {},
  } });
  await f.session.prompt('/plan 规划');
  for (let i = 0; i < 50 && f.requests.length < 1; i++) await pause(20);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.proposedPlan.text, '# Plan\n- do it\n');
  for (let i = 0; i < 50 && f.requests.length < 2; i++) await pause(20);
  assert.equal(f.requests.length, 2, 'picker choice 1 dispatches the implementation turn');
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.mode, 'execute');
  const kickoff = f.requests[1].messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('');
  assert.match(kickoff, /Implement the plan\./);
  assert.match(JSON.stringify(f.requests[1].messages), /Collaboration Mode: Default/, 'mode instructions precede the kickoff');
});

test('actual picker stay keeps Plan mode; /codex-implement fresh carries the plan into a new session', async t => {
  const f = await sessionFixture(t, () => 'Here is my plan.\n<proposed_plan>\n# Plan\n- fresh\n</proposed_plan>');
  await f.session.bindExtensions({ mode: 'rpc', uiContext: {
    select: async (_title, choices) => choices[2], input: async () => '', confirm: async () => false, notify() {}, setStatus() {}, setWidget() {},
  } });
  await f.session.prompt('/plan 规划');
  let settled = false;
  for (let i = 0; i < 50; i++) { const state = new State(() => {}, f.sessionManager.getBranch()).data; if (state.proposedPlan) { settled = true; break; } await pause(20); }
  assert.ok(settled, 'the planning turn settled and produced a plan');
  await pause(50);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.mode, 'plan', 'staying keeps Plan mode');
  assert.equal(f.requests.length, 1);
  const extension = f.loader.getExtensions().extensions.find(e => e.commands.has('codex-implement'));
  const captured = {};
  const ctx = { mode: 'rpc', isIdle: () => true, hasUI: true, ui: { notify() {} },
    sessionManager: { getSessionFile: () => '/parent/session.jsonl' },
    newSession: async options => { captured.options = options; return { cancelled: false }; } };
  await extension.commands.get('codex-implement').handler('fresh', ctx);
  assert.equal(captured.options.parentSession, '/parent/session.jsonl');
  captured.options.setup({ appendMessage: message => captured.appended = message });
  assert.equal(captured.appended.role, 'custom');
  assert.equal(captured.appended.customType, 'pi-codex-approved-plan');
  assert.equal(captured.appended.content, '# Plan\n- fresh\n');
  assert.equal(captured.appended.display, false);
  await captured.options.withSession({ sendUserMessage: async text => { captured.kickoff = text; } });
  assert.equal(captured.kickoff, 'Implement the plan.');
  await extension.commands.get('codex-implement').handler('', { ...ctx, newSession: async () => ({ cancelled: false }) });
});
