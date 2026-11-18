import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { fixture } from './helpers.mjs';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { statusText, installUI, refreshStatus, permissionPicker, planImplementationPicker, selectPermission, selectPlanImplementation, renderToolCall, renderToolResult, approvalPicker, selectApproval, subagentSettingsPicker, configureSubagents } from '../src/ui.mjs';
import { approvalOptions } from '../src/approvals.mjs';
import { planSelectionItems } from '../src/plan.mjs';
test('tool cards fit narrow widths, Chinese text and long output without terminal control escapes', async t => {
  const f = await fixture(t); f.runtime.state.updatePlan([{ step: '实现中文交互', status: 'in_progress' }]);
  const theme = { fg: (_color, text) => text };
  const call = renderToolCall({ cmd: 'printf 中文\u001b[2J' }, theme, '终端');
  const output = renderToolResult({ content: [{ type: 'text', text: Array(100).fill('长输出：中文\u001b[2J').join('\n') }] }, { expanded: false, isPartial: false }, theme);
  for (const width of [1, 12, 24, 80]) for (const component of [call, output]) {
    const lines = component.render(width); assert.ok(lines.every(line => visibleWidth(line) <= width)); assert.ok(lines.every(line => !line.includes('\u001b[2J')));
  }
  assert.match(statusText(f.runtime), /实现中文交互/);
});
test('status lives once in the editor border, clears the extension footer and preserves native editing', async t => {
  const f = await fixture(t); f.runtime.setPermission('ask-for-approval');
  let footer = 'old duplicate', factory, renders = 0;
  const ctx = { mode: 'tui', ui: { theme: { fg: (_color, text) => text }, setStatus: (key, value) => { assert.equal(key, 'pi-codex'); footer = value; }, setEditorComponent: value => { factory = value; }, setFooter: () => { throw Error('Preserve Pi model/token footer'); } } };
  installUI(ctx, f.runtime);
  assert.equal(footer, undefined);
  const editor = factory({ terminal: { rows: 40 }, requestRender: () => renders++ }, { borderColor: text => text }, { matches: (data, action) => data === '\u0014' && action === 'app.tools.expand' });
  const idle = editor.render(90).join('\n');
  assert.equal((idle.match(/Ask for Approval/g) ?? []).length, 1);
  assert.match(idle, /执行/); assert.doesNotMatch(idle, /0\/16|\+0|问题 0|审批 0/);
  assert.equal(editor.handleInput, CustomEditor.prototype.handleInput, 'Native keyboard handling is inherited');
  editor.setText('中文输入与草稿'); editor.focused = true;
  assert.ok(editor.render(90).some(line => line.includes(CURSOR_MARKER)), 'Native hardware cursor marker supports IME');
  let toggled = 0; editor.onAction('app.tools.expand', () => toggled++); editor.handleInput('\u0014'); assert.equal(toggled, 1);
  assert.equal(editor.getText(), '中文输入与草稿');
  const before = JSON.stringify(f.runtime.state.data); refreshStatus(ctx, f.runtime);
  assert.ok(renders > 0); assert.equal(JSON.stringify(f.runtime.state.data), before);
  f.runtime.state.data.questions.q = { status: 'pending' }; f.runtime.state.data.approvals.push({ status: 'pending' });
  assert.equal(statusText(f.runtime), 'Ask for Approval · 待答 1 · 待批准 1');
  assert.match(editor.render(90)[0], /待批准 1.*待答 1/);
  delete f.runtime.state.data.questions.q; f.runtime.state.data.approvals = [];
});
test('editor border adapts to narrow Chinese terminals, permissions, native progress and scrolling', async t => {
  const f = await fixture(t); let factory;
  installUI({ mode: 'tui', ui: { theme: { fg: (_color, text) => `\u001b[36m${text}\u001b[0m` }, setStatus() {}, setEditorComponent: value => { factory = value; } } }, f.runtime);
  const editor = factory({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: text => text }, { matches: () => false });
  f.runtime.state.updatePlan([{ step: '修复中文边框，同时保留光标、补全与原生快捷键', status: 'in_progress' }]);
  editor.setWorkingStatusIndicator({ kind: 'compaction', renderInBorder: () => '⠋ Compacting context…', renderSpinnerInBorder: () => '⠋' });
  for (const preset of ['ask-for-approval', 'full-access', 'read-only']) {
    f.runtime.setPermission(preset);
    for (const width of [0, 1, 6, 12, 24, 40, 64, 90, 120]) {
      const line = editor.renderTopBorder(width, 9);
      assert.ok(visibleWidth(line) <= width, `${preset} at ${width} columns`);
      if (width >= 40) { assert.match(line, /↑ 9/); assert.match(line, /Compacting context|压缩中|⠋/); }
    }
  }
});
test('permission picker fits Chinese descriptions, marks the current setting, and requires explicit submission', () => {
  const submitted = []; let rendered = 0;
  const picker = permissionPicker({ requestRender: () => rendered++ }, { fg: (_color, value) => value }, 'read-only', value => submitted.push(value));
  for (const width of [1, 12, 40, 76]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
  for (const rows of [6, 8, 12, 24]) for (const width of [12, 40, 76]) {
    const compact = permissionPicker({ terminal: { rows }, requestRender() {} }, { fg: (_color, value) => value }, 'read-only', () => {});
    assert.ok(compact.render(width).length <= Math.max(5, Math.floor(rows * 0.9)));
    assert.match(compact.render(width).join('\n'), /Esc/);
  }
  assert.equal((picker.render(76).join('\n').match(/\(当前\)/g) ?? []).length, 1);
  picker.handleInput('2'); assert.deepEqual(submitted, []);
  picker.handleInput('\r'); assert.deepEqual(submitted, ['full-access']); assert.ok(rendered > 0);
  const cancelled = permissionPicker({ requestRender() {} }, { fg: (_color, value) => value }, 'full-access', value => submitted.push(value));
  cancelled.handleInput('\u001b'); assert.equal(submitted.at(-1), undefined);
});
test('RPC permission selection uses standard dialogs and cancellation leaves the policy unchanged', async () => {
  const calls = [];
  const ctx = { mode: 'rpc', hasUI: true, ui: { select: async (title, options) => { calls.push({ title, options }); return options[1]; } } };
  assert.equal(await selectPermission(ctx, 'ask-for-approval'), 'full-access');
  assert.equal(calls[0].options.length, 3); assert.match(calls[0].options[0], /Ask for Approval \(当前\)/);
  ctx.ui.select = async () => undefined; assert.equal(await selectPermission(ctx, 'read-only'), undefined);
});
test('plan implementation picker renders the Codex selection view and blocks disabled options', () => {
  const submitted = [];
  const theme = { fg: (_color, value) => value };
  const items = planSelectionItems({ planMarkdown: '- Step\n', usageLabel: '89% used' });
  const picker = planImplementationPicker({ requestRender() {} }, theme, items, value => submitted.push(value));
  const wide = picker.render(76).join('\n');
  assert.match(wide, /Implement this plan\?/);
  assert.match(wide, /1\. Yes, implement this plan\s+Switch to Default and start coding/);
  assert.match(wide, /2\. Yes, clear context and implement[\s\S]*?Start a fresh thread \(current[\s\S]*?context: 89% used\)/, 'long descriptions wrap like the Codex selection view');
  assert.match(wide, /3\. No, stay in Plan mode\s+Continue planning with the model/);
  assert.match(wide, /enter select · esc back/);
  for (const width of [1, 12, 40, 76]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
  picker.handleInput('\r'); assert.deepEqual(submitted, ['implement']);
  picker.handleInput('\u001b'); assert.equal(submitted.at(-1), undefined);
  const denied = [];
  const missing = planImplementationPicker({ requestRender() {} }, theme, planSelectionItems({ planMarkdown: '  \n' }), value => denied.push(value));
  assert.match(missing.render(76).join('\n'), /No approved plan available/);
  missing.handleInput('2'); missing.handleInput('\r');
  assert.deepEqual(denied, ['implement'], 'number keys on a disabled option are ignored; Enter submits the enabled selection');
});
test('RPC plan implementation selection maps dialog choices back to option ids', async () => {
  const calls = [];
  const ctx = { mode: 'rpc', hasUI: true, ui: { select: async (title, options) => { calls.push({ title, options }); return options[1]; } } };
  assert.equal(await selectPlanImplementation(ctx, { planMarkdown: '- Step\n' }), 'fresh');
  assert.equal(calls[0].title, 'Implement this plan?');
  assert.match(calls[0].options[1], /Fresh thread with this plan/);
  ctx.ui.select = async () => undefined;
  assert.equal(await selectPlanImplementation(ctx, { planMarkdown: '- Step\n' }), undefined);
});
test('approval picker shows the Codex decision set, fits narrow widths, and Esc denies', () => {
  const submitted = []; let rendered = 0;
  const theme = { fg: (_color, value) => value };
  const options = approvalOptions({ kind: 'exec', command: 'podman exec -it ctr bash', cwd: '/repo', escalated: true });
  assert.deepEqual(options.map(option => option.id), ['once', 'session', 'prefix', 'deny']);
  const picker = approvalPicker({ terminal: { rows: 24 }, requestRender: () => rendered++ }, theme, { owner: 'root', operation: 'Run outside OS sandbox for this command only.\nCommand: podman exec -it ctr bash', options }, value => submitted.push(value));
  const wide = picker.render(76).join('\n');
  assert.match(wide, /执行批准 \/ Approval \[root\]/);
  assert.match(wide, /podman exec -it ctr bash/);
  assert.match(wide, /本会话不再询问此命令/);
  assert.match(wide, /不再询问以此开头的命令：podman exec -it ctr bash/);
  for (const width of [1, 12, 40, 76]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
  for (const rows of [6, 10, 24]) {
    const compact = approvalPicker({ terminal: { rows }, requestRender() {} }, theme, { owner: 'root', operation: 'op', options }, () => {});
    assert.ok(compact.render(76).length <= Math.max(5, Math.floor(rows * 0.9)) + 6, `rows ${rows} bounds the operation preview`);
  }
  picker.handleInput('3'); assert.deepEqual(submitted, [], 'number keys move the selection without submitting');
  picker.handleInput('\r'); assert.deepEqual(submitted, ['prefix']); assert.ok(rendered > 0);
  picker.handleInput('\u001b'); assert.equal(submitted.at(-1), 'deny', 'Esc denies like the old confirm dialog');
  const plain = approvalPicker({ terminal: { rows: 24 }, requestRender() {} }, theme, { owner: 'root', operation: 'op', options: approvalOptions({ kind: 'external', name: 'tool' }) }, () => {});
  assert.doesNotMatch(plain.render(76).join('\n'), /开头的命令/, 'no prefix option without a derivable prefix');
});
test('RPC approval selection maps dialog choices back to option ids and denies on cancel', async () => {
  const calls = [];
  const ui = { available: true, select: async (title, options) => { calls.push({ title, options }); return options[1]; } };
  const options = approvalOptions({ kind: 'exec', command: 'printf hi', cwd: '/repo', escalated: false });
  assert.equal(await selectApproval(ui, { owner: 'root', operation: 'op', options, mode: 'rpc' }), 'session');
  assert.match(calls[0].title, /Approval \[root\]\nop/);
  assert.equal(calls[0].options.length, 4);
  ui.select = async () => undefined;
  assert.equal(await selectApproval(ui, { owner: 'root', operation: 'op', options, mode: 'rpc' }), 'deny');
});
test('subagent settings picker walks menu → model → thinking, disables unset clears, and Esc backs out', async () => {
  const applied = [], cleared = [];
  let snapshotState = { effective: '跟随主会话 · thinking high · 来源 inherit', session: '未设置', sessionSet: false, global: '未设置', globalSet: false };
  const options = {
    snapshot: () => snapshotState,
    models: [{ provider: 'mock', id: 'mock-code', name: 'Mock' }, { provider: 'other', id: 'm2', name: 'Model Two' }],
    levelsFor: () => ['off', 'low', 'medium', 'high'],
    apply: async (layer, value) => { applied.push({ layer, value }); snapshotState = { ...snapshotState, [layer === 'session' ? 'session' : 'global']: 'updated', [layer === 'session' ? 'sessionSet' : 'globalSet']: true }; },
    clear: async layer => { cleared.push(layer); snapshotState = { ...snapshotState, [layer === 'session' ? 'session' : 'global']: '未设置', [layer === 'session' ? 'sessionSet' : 'globalSet']: false }; },
  };
  let finished = false;
  const theme = { fg: (_color, value) => value };
  const picker = subagentSettingsPicker({ terminal: { rows: 24 }, requestRender() {} }, theme, options, () => { finished = true; });
  const menu = picker.render(76).join('\n');
  assert.match(menu, /子代理配置 \/ Subagent settings/);
  assert.match(menu, /生效（新 spawn）/);
  assert.match(menu, /1\. 配置会话层/);
  assert.match(menu, /3\. 清除会话层/, 'clear rows stay visible while unset');
  for (const width of [1, 12, 40, 76]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
  picker.handleInput('3'); picker.handleInput('\r');
  assert.deepEqual(cleared, [], 'disabled clear rows are not activated by their digit key');
  assert.match(picker.render(76).join('\n'), /子代理模型 \/ Subagent model · 会话层/, 'Enter still activates the focused enabled row');
  picker.handleInput('2'); picker.handleInput('\r');
  assert.match(picker.render(76).join('\n'), /思考强度 \/ Thinking level/);
  assert.match(picker.render(76).join('\n'), /mock\/mock-code/);
  picker.handleInput('\u001b');
  assert.match(picker.render(76).join('\n'), /子代理模型 \/ Subagent model/, 'Esc from thinking returns to the model view');
  picker.handleInput('\u001b');
  assert.match(picker.render(76).join('\n'), /配置会话层/, 'Esc from the model view returns to the menu');
  picker.handleInput('1'); picker.handleInput('\r'); picker.handleInput('2'); picker.handleInput('\r'); picker.handleInput('3'); picker.handleInput('\r');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(applied, [{ layer: 'session', value: { model: { provider: 'mock', id: 'mock-code' }, thinking: 'low' } }]);
  assert.match(picker.render(76).join('\n'), /已更新会话层/, 'the menu refreshes after applying');
  assert.match(picker.render(76).join('\n'), /会话层（仅内存）：updated/);
  picker.handleInput('3'); picker.handleInput('\r');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(cleared, ['session'], 'clear activates once the layer is set');
  picker.handleInput('5'); picker.handleInput('\r');
  assert.equal(finished, true, 'the close row finishes the overlay');
  const many = subagentSettingsPicker({ terminal: { rows: 10 }, requestRender() {} }, theme, { ...options, models: Array.from({ length: 30 }, (_, index) => ({ provider: 'p', id: `m${index}`, name: `Model ${index}` })) }, () => {});
  many.handleInput('1'); many.handleInput('\r');
  assert.ok(many.render(76).length <= 24, 'long model lists render inside a bounded window');
  assert.match(many.render(76).join('\n'), /共 31 项/, 'the scroll hint reports the full row count');
});
test('RPC subagent settings use sequential standard dialogs', async () => {
  const calls = [];
  let round = 0;
  const ctx = { mode: 'rpc', hasUI: true, ui: { select: async (title, choices) => { calls.push({ title, choices }); return ++round === 1 ? choices[0] : '关闭 / Close'; }, notify() {} } };
  let cleared = false;
  await configureSubagents(ctx, {
    snapshot: () => ({ effective: 'e', session: '已设置', sessionSet: true, global: '未设置', globalSet: false }),
    models: [{ provider: 'mock', id: 'mock-code', name: 'Mock' }],
    levelsFor: () => ['off', 'high'],
    apply: async () => {},
    clear: async () => { cleared = true; },
  });
  assert.match(calls[0].title, /子代理配置 \/ Subagents/);
  assert.ok(calls[0].choices.includes('清除会话层 / Clear session layer'), 'set layers offer clear actions');
  assert.equal(calls[1].choices[0], '跟随主会话 / Inherit current model');
  assert.ok(calls[2].choices.includes('off'));
  assert.equal(cleared, false);
});
