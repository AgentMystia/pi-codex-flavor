import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { CORE_PROMPT, AGENT_PROMPT, REVIEW_PROMPT, SKILLS_PROMPT, composePrompt, composeAgentPrompt, applyPromptSections, CODEX_CORE_SECTION, CODEX_SKILLS_SECTION } from '../src/prompt.mjs';
import { forkMessages } from '../src/threads.mjs';
import { State } from '../src/state.mjs';
import { model, callTool, lastText, pause } from './helpers.mjs';
import { fixture, sessionFixture } from './helpers.mjs';
test('actual Pi profile loads stable tools, preserves user prompt and runs tracked modification', async t => {
  let called = false;
  const f = await sessionFixture(t, () => {
    if (!called) { called = true; return callTool('write', { path: '日常.txt', content: 'daily development' }); } return 'implemented';
  });
  await f.session.prompt('Implement the file');
  assert.equal(await readFile(path.join(f.root, '日常.txt'), 'utf8'), 'daily development');
  assert.match(JSON.stringify(f.requests[0]), /USER CUSTOM PROMPT/); assert.match(JSON.stringify(f.requests[0]), /Codex flavor extension/);
  assert.ok(new State(() => {}, f.sessionManager.getBranch()).data.changes.length);
  assert.equal(f.requests.length, 2);
  const tools = f.requests[0].messages[0].toolsAdded;
  assert.ok(tools.some(tool => tool.name === 'request_user_input'));
  assert.ok(!tools.some(tool => tool.name === 'lsp'));
  assert.ok(!tools.some(tool => tool.name === 'powershell'), 'PowerShell shim must not be declared on this Linux-only flavor');
  assert.ok(!getSystemMessageText(f.requests[0].messages[0]).includes(SKILLS_PROMPT), 'Skill guidance stays out of skill-less sessions');
});
test('skill guidance is composed only when the base prompt carries a skills section', () => {
  const base = 'USER CUSTOM PROMPT.';
  const withSkills = composePrompt(base + '\n\n<skills>\n<available_skills>\n</available_skills>\n</skills>', true);
  assert.equal(withSkills.split(CORE_PROMPT).length - 1, 1);
  assert.ok(withSkills.includes(SKILLS_PROMPT));
  assert.ok(withSkills.endsWith(SKILLS_PROMPT));
  assert.equal(composePrompt(base).includes(SKILLS_PROMPT), false, 'No skills section means no skill guidance');
  const markerOnly = composePrompt(base);
  assert.equal(markerOnly.includes(SKILLS_PROMPT), false, 'A bare base without a skills section never gets skill guidance');
  assert.equal(composePrompt(withSkills, true).split(SKILLS_PROMPT).length - 1, 1, 'Already-composed prompts never duplicate the guidance');
});
test('core and skill guidance are contributed as diffable sections without forcing the prompt', () => {
  const plain = { sections: {} };
  applyPromptSections(plain, 'USER CUSTOM PROMPT.');
  assert.equal(plain.sections[CODEX_CORE_SECTION], CORE_PROMPT);
  assert.equal(plain.sections[CODEX_SKILLS_SECTION], undefined, 'No skills section means no skill guidance');
  const skilled = { sections: {} };
  applyPromptSections(skilled, 'USER CUSTOM PROMPT.\n\n<skills>\n<available_skills>\n</available_skills>\n</skills>');
  assert.equal(skilled.sections[CODEX_CORE_SECTION], CORE_PROMPT);
  assert.equal(skilled.sections[CODEX_SKILLS_SECTION], SKILLS_PROMPT);
});
test('agent prompts drop the mcp_servers section their tool set cannot reach', () => {
  const base = 'USER CUSTOM PROMPT.\n\n<mcp_servers>\nMCP servers whose tools are not declared to you.\n- demo (codemode): demo server\n</mcp_servers>\n\n<cwd>/tmp</cwd>';
  const prompt = composeAgentPrompt(base, 'worker', false);
  assert.ok(!prompt.includes('<mcp_servers>'));
  assert.equal(prompt.split(CORE_PROMPT).length - 1, 1);
  assert.match(prompt, /Delegated role: worker\./);
  assert.match(composeAgentPrompt('USER CUSTOM PROMPT.', 'scout', true), /Delegated role: scout\. Read-only/);
});
test('later mcp_servers sections from extensions loaded after the suite still reach the provider', async t => {
  const f = await sessionFixture(t, () => 'done', [pi => {
    // Mimics the built-in MCP extension, which loads after discovered extensions and
    // contributes its section from its own before_agent_start handler.
    pi.on('before_agent_start', event => {
      event.systemPromptOptions.sections.mcp_servers = 'MCP servers whose tools are not declared to you.\n- demo (codemode): demo server';
    });
  }]);
  await f.session.prompt('List the servers');
  const system = getSystemMessageText(f.requests[0].messages[0]);
  assert.match(system, /USER CUSTOM PROMPT/);
  assert.match(system, /Codex flavor extension/, 'the Codex core still composes into the same prompt');
  assert.match(system, /<codex_core>/, 'the core arrives as a labeled section');
  assert.match(system, /<mcp_servers>[\s\S]*demo \(codemode\)[\s\S]*<\/mcp_servers>/, 'the native MCP context injection is no longer dropped');
  await f.session.prompt('Second');
  assert.equal(JSON.stringify(f.requests[1].messages[0]), JSON.stringify(f.requests[0].messages[0]), 'an unchanged section set adds no prompt tokens');
});
test('real Pi exec_command, write_stdin and bash send a status line and raw output to the provider', async t => {
  let stage = 0;
  const f = await sessionFixture(t, context => {
    stage++;
    if (stage === 1) return callTool('exec_command', { cmd: 'printf "first\\n"; read line; printf "second:%s\\n" "$line"', yield_time_ms: 10 });
    if (stage === 2) {
      const result = context.messages.findLast(message => message.role === 'toolResult');
      const session = Number(result.content[0].text.match(/session ID (\d+)/)[1]);
      return callTool('write_stdin', { session_id: session, chars: 'hello\n', eof: true, yield_time_ms: 1000 }, 'stdin');
    }
    if (stage === 3) return callTool('bash', { command: 'printf "bash-line-one\\nbash-line-two\\n"' }, 'bash');
    return 'done';
  });
  await f.session.prompt('Exercise the terminal');
  assert.equal(f.requests.length, 4);
  const results = f.requests.at(-1).messages.filter(message => message.role === 'toolResult');
  assert.deepEqual(results.map(message => message.toolName), ['exec_command', 'write_stdin', 'bash']);
  for (const message of results) {
    const text = message.content[0].text;
    assert.match(text, /^(Exit code \d+|Running) \(\d+\.\ds\)/);
    assert.doesNotMatch(text, /"output":|"running":|"cancelled":|"isolated":|process_/);
  }
  assert.match(results.at(-1).content[0].text, /^Exit code 0 \(\d+\.\ds\)\nbash-line-one\nbash-line-two\n$/);
});
test('actual Pi UI browsing and tool folding cause no request changes or additional requests', async t => {
  const f = await sessionFixture(t, () => 'done'); await f.session.prompt('First');
  const system = JSON.stringify(f.requests[0].messages[0]); const count = f.requests.length;
  let editorFactory;
  await f.session.bindExtensions({ mode: 'tui', uiContext: {
    theme: { fg: (_color, text) => text }, setStatus() {}, notify() {},
    setEditorComponent: factory => { editorFactory = factory; },
  } });
  assert.ok(editorFactory);
  const editor = editorFactory({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: text => text }, { matches: () => false });
  editor.setText('中文草稿');
  for (const width of [24, 64, 100]) editor.render(width);
  assert.equal(f.requests.length, count);
  const extension = f.loader.getExtensions().extensions.find(e => e.commands.has('codex-state'));
  let shown = '';
  const ctx = { mode: 'rpc', ui: { notify: text => { shown = text; } } };
  await extension.commands.get('codex-state').handler('', ctx);
  assert.match(shown, /Codex state/); assert.equal(f.requests.length, count);
  await f.session.prompt('Second');
  assert.equal(JSON.stringify(f.requests[1].messages[0]), system);
});
test('delegated and reviewer prompts retain the user prompt and current Codex core once, with the real Pi review protocol', async t => {
  const f = await fixture(t);
  f.context.getSystemPrompt = () => composePrompt('USER CUSTOM PROMPT AND PROJECT RULES');
  const child = f.runtime.threads.spawn('root', { message: 'Inspect the assigned change', role: 'reviewer' });
  await f.runtime.threads.live.get(child.id).run;
  const prompt = f.requests[0].messages.find(message => message.role === 'system').content;
  assert.match(prompt, /USER CUSTOM PROMPT AND PROJECT RULES/);
  assert.equal(prompt.split(CORE_PROMPT).length - 1, 1);
  assert.equal(prompt.split(AGENT_PROMPT).length - 1, 1);
  assert.equal(prompt.split(REVIEW_PROMPT).length - 1, 1);
  assert.match(prompt, /Delegated role: reviewer\. Read-only/);
  assert.match(prompt, /review_comment using path, line, severity/);
  const workflow = await f.call('load_workflow', { name: 'review' });
  assert.match(workflow.content[0].text, /The bug is discrete and actionable/);
  assert.doesNotMatch(workflow.content[0].text, /overall_correctness/);
});
test('actual Pi RPC questions use the host standard dialog channel', async t => {
  let turns = 0;
  const f = await sessionFixture(t, context => ++turns === 1 ? callTool('request_user_input', { questions: [{ id: 'q', question: 'Which storage?', options: [{ label: 'Local (Recommended)', description: 'No service' }, { label: 'Remote', description: 'Shared' }] }] }) : 'done');
  let inputCalls = 0;
  await f.session.bindExtensions({ mode: 'rpc', uiContext: {
    select: async (_title, options) => { inputCalls++; return options[0]; }, input: async () => 'explicit', confirm: async () => false,
    notify() {}, setStatus() {}, setWidget() {},
  } });
  await f.session.prompt('Ask the user'); assert.equal(inputCalls, 1);
  const state = new State(() => {}, f.sessionManager.getBranch()).data;
  assert.equal(state.decisions.length, 1); assert.equal(state.approvals.length, 0);
});
test('actual /permissions command selects and restores policy without a model request or duplicate visible chat entry', async t => {
  const f = await sessionFixture(t, () => 'done');
  const command = f.loader.getExtensions().extensions.find(extension => extension.commands.has('permissions'));
  assert.ok(command.commands.has('permissions'));
  assert.deepEqual(command.commands.get('permissions').getArgumentCompletions('full').map(item => item.value), ['full-access']);
  await f.session.prompt('/permissions Read-Only');
  assert.equal(f.requests.length, 0);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.permissionPreset, 'read-only');
  const entry = f.sessionManager.getBranch().find(entry => entry.customType === 'pi-codex-permission');
  assert.ok(entry); assert.equal(entry.display, false);
  await f.session.prompt('/permissions Full Access');
  assert.equal(f.requests.length, 0);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.permissionPreset, 'full-access');
  await f.session.prompt('/permissions Ask for Approval');
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.permissionPreset, 'ask-for-approval');
  await f.session.prompt('Continue'); assert.equal(f.requests.length, 1);
  assert.match(JSON.stringify(f.requests[0]), /The user selected Ask for Approval/);
});
test('actual RPC /permissions picker cancellation preserves policy; Read-Only blocks model-issued edits', async t => {
  let turns = 0, confirmed = 0;
  const f = await sessionFixture(t, () => ++turns === 1 ? callTool('write', { path: 'blocked', content: 'must not be written' }) : 'done');
  let selected;
  await f.session.bindExtensions({ mode: 'rpc', uiContext: {
    select: async (_title, choices) => selected === undefined ? undefined : choices[selected],
    confirm: async () => { confirmed++; return true; }, notify() {}, setStatus() {}, setWidget() {},
  } });
  await f.session.prompt('/permissions');
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.permissionPreset, null);
  selected = 2; await f.session.prompt('/permissions'); assert.equal(f.requests.length, 0);
  assert.equal(new State(() => {}, f.sessionManager.getBranch()).data.permissionPreset, 'read-only');
  await f.session.prompt('Try writing');
  await assert.rejects(access(path.join(f.root, 'blocked')));
  const error = f.sessionManager.getBranch().find(entry => entry.message?.role === 'toolResult');
  assert.equal(error.message.isError, true); assert.match(JSON.stringify(error.message.content), /Read-only/);
  assert.equal(confirmed, 0);
});
test('structured tool results serialize compactly and failing errors stay bounded like Codex', async t => {
  let stage = 0;
  const f = await sessionFixture(t, () => {
    stage++;
    if (stage === 1) return callTool('task_status', { title: '长任务', status: 'in_progress', note: '备注' });
    if (stage === 2) return callTool('write', { path: `${'../'.repeat(300)}escape`, content: 'x' });
    return 'done';
  });
  await f.session.prompt('Run the tools');
  assert.equal(f.requests.length, 3);
  const results = f.requests.at(-1).messages.filter(message => message.role === 'toolResult');
  const taskText = results[0].content[0].text;
  assert.match(taskText, /^task_[0-9a-f]{12} in_progress$/, 'a task update answers with its id and status instead of echoing the request');
  assert.doesNotMatch(taskText, /\n\s+"/, 'no pretty-printed indentation reaches the provider');
  const failure = results[1];
  assert.equal(failure.isError, true);
  assert.ok(Buffer.byteLength(failure.content[0].text) <= 1100, 'error text is middle-truncated near the 900-byte Codex bound');
  assert.match(failure.content[0].text, /chars truncated/);
  assert.match(failure.content[0].text, /Path outside workspace/);
});
test('actual /subagent command configures layers without model requests; the session layer stays memory-only', async t => {
  const f = await sessionFixture(t, () => 'done');
  const notifications = [];
  const selects = [];
  await f.session.bindExtensions({ mode: 'rpc', uiContext: {
    select: async (title, choices) => { selects.push({ title, choices }); return choices.includes('关闭 / Close') ? '关闭 / Close' : choices[0]; },
    input: async () => '', confirm: async () => false,
    notify: (message, kind) => notifications.push({ message, kind }), notify2: undefined, setStatus() {}, setWidget() {},
  } });
  await f.session.prompt('/subagent');
  assert.equal(f.requests.length, 0, 'viewing subagent config never triggers a model request');
  assert.match(selects[0].title, /子代理配置 \/ Subagents/, 'the RPC settings view opens with the standard dialog');
  assert.match(selects[0].title, /生效（新 spawn）/, 'the view shows the effective configuration');
  await f.session.prompt('/subagent session mock/mock-code max');
  assert.equal(f.requests.length, 0);
  const entry = f.sessionManager.getBranch().filter(item => item.customType === 'pi-codex-subagent').at(-1);
  assert.ok(entry); assert.equal(entry.display, false);
  assert.match(entry.content, /mock\/mock-code/); assert.match(entry.content, /source session/); assert.match(entry.content, /thinking max/);
  assert.equal(await access(path.join(f.agentHome, 'pi-codex', 'subagents.json')).then(() => true, () => false), false, 'the session layer writes no file');
  await f.session.prompt('/subagent global mock/mock-code max');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.agentHome, 'pi-codex', 'subagents.json'), 'utf8')), { model: { provider: 'mock', id: 'mock-code' }, thinking: 'max' });
  await f.session.prompt('/subagent clear global');
  assert.equal(await access(path.join(f.agentHome, 'pi-codex', 'subagents.json')).then(() => true, () => false), false);
  await f.session.prompt('/subagent session mock/nope');
  assert.ok(notifications.some(item => item.kind === 'error' && /Unknown model/.test(item.message)), 'unknown models are rejected with a notification');
  assert.equal(f.requests.length, 0);
});
test('the main session reads a finished child notification at its next request without an extra turn', async t => {
  let stage = 0;
  const f = await sessionFixture(t, async context => {
    const system = getSystemMessageText(context.messages.find(message => message.role === 'system') ?? { content: context.systemPrompt ?? '' });
    if (/Delegated role/.test(system)) { await pause(200); return 'child findings ready'; }
    stage++;
    if (stage === 1) return callTool('spawn_agent', { message: 'investigate' });
    if (stage === 2) return callTool('exec_command', { cmd: 'sleep 1', yield_time_ms: 5000 });
    return 'integrated';
  });
  await f.session.prompt('Delegate and continue');
  const rootRequests = f.requests.filter(request => !/Delegated role/.test(getSystemMessageText(request.messages.find(message => message.role === 'system') ?? { content: '' })));
  assert.equal(rootRequests.length, 3, 'the notification adds no model request of its own');
  const conversation = request => JSON.stringify(request.messages.filter(message => message.role !== 'system'));
  assert.match(conversation(rootRequests[2]), /subagent_notification[^]*child findings ready/);
  assert.doesNotMatch(conversation(rootRequests[1]), /subagent_notification/);
});
test('a child finishing after the main session went idle is recorded without starting a turn', async t => {
  let stage = 0;
  const f = await sessionFixture(t, async context => {
    const system = getSystemMessageText(context.messages.find(message => message.role === 'system') ?? { content: '' });
    if (/Delegated role/.test(system)) { await pause(300); return 'late findings'; }
    return ++stage === 1 ? callTool('spawn_agent', { message: 'investigate' }) : 'handed off';
  });
  await f.session.prompt('Delegate and stop');
  const count = f.requests.length;
  await pause(800);
  assert.equal(f.requests.length, count, 'no model request follows the notification');
  const notice = f.sessionManager.getBranch().find(entry => entry.customType === 'pi-codex-agent-notification');
  assert.match(notice?.content ?? '', /late findings/);
});
test('a user shell command streams through the policy executor and cancels with Pi own signal instead of a timeout', async t => {
  const f = await sessionFixture(t, () => 'done');
  const handled = await f.session.extensionRunner.emitUserBash({ type: 'user_bash', command: 'echo hi', excludeFromContext: false, cwd: f.root });
  assert.ok(handled.operations && !handled.result, 'Pi keeps streaming, logging and Escape handling');
  const chunks = [];
  assert.deepEqual(await handled.operations.exec('echo streamed; exit 3', f.root, { onData: data => chunks.push(data.toString()) }), { exitCode: 3 });
  assert.equal(chunks.join(''), 'streamed\n');
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const stopped = await handled.operations.exec('sleep 30', f.root, { onData: () => {}, signal: controller.signal });
  assert.ok(Date.now() - started < 3000);
  assert.equal(stopped.exitCode, 137, 'a killed command reports 128 + SIGKILL');
});
test('fork excludes unfinished local tool batches and retains completed native history', () => {
  const native = { role: 'assistant', content: [{ type: 'text', text: 'native' }], opaqueNative: { opaque: true } };
  const messages = [native, { role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'spawn_agent' }] }];
  assert.deepEqual(forkMessages(messages), [native]);
});
