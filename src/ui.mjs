import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, visibleWidth, matchesKey } from '@earendil-works/pi-tui';
import { cleanTerminal } from './util.mjs';
import { PERMISSION_PRESETS } from './permissions.mjs';
import { PLAN_IMPLEMENTATION_TITLE, PLAN_IMPLEMENTATION_HINT, planSelectionItems } from './plan.mjs';
class BoundedText extends Text {
  render(width) { return width <= 0 ? [''] : super.render(width).map(line => truncateToWidth(line, width, '')); }
}
const redraws = new WeakMap();
const compactPermissions = { 'ask-for-approval': '需批准', 'full-access': '完全访问', 'read-only': '只读', custom: '自定义' };
function statusDetails(runtime) {
  const state = runtime.state.data;
  const scheduler = runtime.scheduler.snapshot();
  const questions = Object.values(state.questions).filter(q => q.status === 'pending').length;
  const approvals = state.approvals.filter(a => a.status === 'pending').length;
  const step = state.plan.find(p => p.status === 'in_progress')?.step;
  const agents = scheduler.active.filter(owner => owner !== 'root').length;
  const queued = scheduler.queued.filter(owner => owner !== 'root').length;
  return { state, scheduler, questions, approvals, step: step ? cleanTerminal(step).replace(/[\r\n\t]+/g, ' ') : '', agents, queued };
}
export function statusText(runtime) {
  const { state, scheduler, questions, approvals, step, agents, queued } = statusDetails(runtime);
  const parts = [runtime.policy.preset.label];
  if (state.mode === 'plan') parts.push('计划');
  if (agents) parts.push(`代理 ${agents}/${scheduler.limit}`);
  if (queued) parts.push(`排队 ${queued}`);
  if (questions) parts.push(`待答 ${questions}`);
  if (approvals) parts.push(`待批准 ${approvals}`);
  if (step) parts.push(step);
  return parts.join(' · ');
}
export class CodexEditor extends CustomEditor {
  constructor(tui, theme, bindings, runtime, palette) {
    super(tui, theme, bindings, { embedWorkingStatus: true });
    this.runtime = runtime; this.palette = palette;
  }
  setWorkingStatusIndicator(indicator) {
    super.setWorkingStatusIndicator(indicator); this.nativeStatus = indicator;
  }
  renderTopBorder(width, hiddenLineCount = 0) {
    if (width <= 0) return '';
    const paint = (color, text) => this.palette()?.fg(color, text) ?? text;
    const border = text => this.borderColor(text);
    const { state, scheduler, questions, approvals, step, agents, queued } = statusDetails(this.runtime);
    const preset = this.runtime.policy.preset;
    const permissionColor = preset.id === 'full-access' ? 'warning' : 'muted';
    const mode = paint('accent', state.mode === 'plan' ? '计划' : '执行');
    const permission = paint(permissionColor, width >= 64 ? preset.label : compactPermissions[preset.id]);
    let left = width >= 24 ? mode + paint('dim', ' · ') + permission : permission;
    if (width < 8) return truncateToWidth(left, width, '');
    left = truncateToWidth(left, width - 4, '…');
    const maxRight = Math.max(0, width - visibleWidth(left) - 7);
    const items = [];
    if (approvals) items.push({ text: `待批准 ${approvals}`, short: `批${approvals}`, color: 'warning' });
    if (questions) items.push({ text: `待答 ${questions}`, short: `答${questions}`, color: 'accent' });
    if (hiddenLineCount) items.push({ text: `↑ ${hiddenLineCount}`, color: 'dim' });
    if (this.nativeStatus) {
      const label = { working: '处理中', retry: '重试中', compaction: '压缩中', branchSummary: '摘要中' }[this.nativeStatus.kind] ?? '处理中';
      const spinner = this.nativeStatus.renderSpinnerInBorder(2);
      items.push({ text: this.nativeStatus.renderInBorder(48), short: `${spinner} ${label}`, tiny: spinner, painted: true });
    }
    if (agents) items.push({ text: `代理 ${agents}/${scheduler.limit}`, short: `代理${agents}`, color: 'muted' });
    if (queued) items.push({ text: `排队 ${queued}`, short: `队${queued}`, color: 'muted' });
    if (step) items.push({ text: step, color: 'dim', truncate: true });
    const right = [];
    let remaining = maxRight;
    for (const item of items) {
      const available = remaining - (right.length ? 3 : 0);
      let text = [item.text, item.short, item.tiny].find(value => value && visibleWidth(value) <= available);
      if (!text && item.truncate && available >= 8) text = truncateToWidth(item.text, available, '…');
      if (!text) continue;
      right.push(item.painted ? text : paint(item.color, text));
      remaining = available - visibleWidth(text);
    }
    if (!right.length) return border('─ ') + left + border(' ' + '─'.repeat(width - visibleWidth(left) - 3));
    const detail = right.join(paint('dim', ' · '));
    const gap = width - visibleWidth(left) - visibleWidth(detail) - 6;
    return border('─ ') + left + border(' ' + '─'.repeat(gap) + ' ') + detail + border(' ─');
  }
}
export function refreshStatus(ctx, runtime) {
  if (ctx.mode !== 'tui') return;
  redraws.get(runtime)?.();
}
export function installUI(ctx, runtime) {
  if (ctx.mode !== 'tui') return;
  ctx.ui.setStatus('pi-codex', undefined);
  ctx.ui.setEditorComponent((tui, theme, bindings) => {
    redraws.set(runtime, () => tui.requestRender());
    return new CodexEditor(tui, theme, bindings, runtime, () => ctx.ui.theme);
  });
}
export function permissionPicker(tui, theme, currentId, done) {
  let selected = Math.max(0, PERMISSION_PRESETS.findIndex(preset => preset.id === currentId));
  const paint = (color, text) => theme.fg(color, text);
  return {
    render(width) {
      if (width <= 0) return [''];
      const height = Math.max(5, Math.floor((tui.terminal?.rows ?? 24) * 0.9));
      const framed = width >= 24 && height >= 9;
      const innerWidth = Math.max(1, width - (framed ? 4 : 0));
      const roomy = innerWidth >= 52 && height >= 16;
      const lines = [paint('accent', 'Permissions')];
      if (height >= 9) lines.push('');
      for (const [index, preset] of PERMISSION_PRESETS.entries()) {
        const focused = index === selected;
        const label = innerWidth >= 36 ? preset.label : compactPermissions[preset.id];
        const title = `${focused ? '›' : ' '} ${index + 1}. ${label}${currentId === preset.id ? (innerWidth >= 36 ? '  (当前)' : ' ✓') : ''}`;
        const row = truncateToWidth(paint(focused ? 'accent' : 'text', title), innerWidth, '');
        lines.push(focused ? theme.bg?.('selectedBg', row + ' '.repeat(innerWidth - visibleWidth(row))) ?? row : row);
        if (roomy) {
          lines.push(...new BoundedText(paint('muted', preset.description), 0, 0).render(Math.max(1, innerWidth - 5)).map(line => '     ' + line));
          lines.push('');
        }
      }
      if (!roomy) {
        const description = new BoundedText(paint('muted', PERMISSION_PRESETS[selected].description), 0, 0).render(innerWidth);
        const available = Math.max(0, height - lines.length - (framed ? 4 : 2));
        if (available) lines.push('', ...description.slice(0, available));
      }
      lines.push(paint('dim', innerWidth >= 36 ? '↑↓ 选择 · Enter 确认 · Esc 返回' : '↵选 Esc退'));
      if (!framed) return lines.map(line => truncateToWidth(line, width, ''));
      return [paint('borderMuted', '╭' + '─'.repeat(width - 2) + '╮'), ...lines.map(line => {
        const content = truncateToWidth(line, innerWidth, '');
        return paint('borderMuted', '│ ') + content + ' '.repeat(innerWidth - visibleWidth(content)) + paint('borderMuted', ' │');
      }), paint('borderMuted', '╰' + '─'.repeat(width - 2) + '╯')];
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) { done(undefined); return; }
      if (matchesKey(data, 'enter')) { done(PERMISSION_PRESETS[selected].id); return; }
      if (matchesKey(data, 'up')) selected = (selected + PERMISSION_PRESETS.length - 1) % PERMISSION_PRESETS.length;
      else if (matchesKey(data, 'down')) selected = (selected + 1) % PERMISSION_PRESETS.length;
      else if (/^[123]$/.test(data)) selected = Number(data) - 1;
      tui.requestRender();
    },
    invalidate() {},
  };
}
export function planImplementationPicker(tui, theme, items, done) {
  let selected = 0;
  const enabled = items.map(item => !item.disabled);
  if (!enabled[selected]) selected = enabled.indexOf(true);
  const paint = (color, text) => theme.fg(color, text);
  return {
    render(width) {
      if (width <= 0) return [''];
      const innerWidth = Math.max(1, width - 4);
      const columns = items.map((item, index) => `${index + 1}. ${item.name}`);
      const nameWidth = Math.max(...columns.map(visibleWidth)) + 3;
      const lines = [paint('accent', PLAN_IMPLEMENTATION_TITLE), ''];
      for (const [index, item] of items.entries()) {
        const focused = index === selected;
        const nameText = `${focused ? '›' : ' '} ${columns[index]}`;
        const paintedName = paint(focused ? 'accent' : 'text', nameText);
        const detail = item.disabled ? paint('warning', item.disabled.reason) : paint('muted', item.description);
        const detailWidth = innerWidth - nameWidth;
        const wrapped = detailWidth >= 12 ? new BoundedText(detail, 0, 0).render(detailWidth) : [];
        const rows = wrapped.length === 1
          ? [paintedName + ' '.repeat(Math.max(0, nameWidth - visibleWidth(nameText))) + wrapped[0]]
          : [paintedName, ...wrapped.map(line => ' '.repeat(nameWidth) + line)];
        for (const row of rows) {
          const content = truncateToWidth(row, innerWidth, '');
          lines.push(focused ? theme.bg?.('selectedBg', content + ' '.repeat(Math.max(0, innerWidth - visibleWidth(content)))) ?? content : content);
        }
      }
      lines.push('', paint('dim', PLAN_IMPLEMENTATION_HINT));
      if (width < 24) return lines.map(line => truncateToWidth(line, width, ''));
      return [paint('borderMuted', '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮'), ...lines.map(line => {
        const content = truncateToWidth(line, innerWidth, '');
        return paint('borderMuted', '│ ') + content + ' '.repeat(Math.max(0, innerWidth - visibleWidth(content))) + paint('borderMuted', ' │');
      }), paint('borderMuted', '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯')];
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) { done(undefined); return; }
      if (matchesKey(data, 'enter')) { const item = items[selected]; done(item.disabled ? undefined : item.id); return; }
      if (matchesKey(data, 'up')) selected = (selected + items.length - 1) % items.length;
      else if (matchesKey(data, 'down')) selected = (selected + 1) % items.length;
      else if (/^[123]$/.test(data)) { const index = Number(data) - 1; if (!items[index].disabled) selected = index; }
      else return;
      tui.requestRender();
    },
    invalidate() {},
  };
}
export async function selectPlanImplementation(ctx, params) {
  const items = planSelectionItems(params);
  if (ctx.mode === 'tui') return ctx.ui.custom((tui, theme, _bindings, done) => planImplementationPicker(tui, theme, items, done), {
    overlay: true, overlayOptions: { width: 76, maxHeight: '90%', anchor: 'center' },
  });
  if (!ctx.hasUI) throw Error('Plan implementation prompt unavailable: no TUI or RPC dialog channel');
  const choices = items.map(item => `${item.name} — ${item.disabled ? item.disabled.reason : item.description}`);
  const selection = await ctx.ui.select(PLAN_IMPLEMENTATION_TITLE, choices);
  return items[choices.indexOf(selection)]?.disabled ? undefined : items[choices.indexOf(selection)]?.id;
}
export async function selectPermission(ctx, currentId) {
  if (ctx.mode === 'tui') return ctx.ui.custom((tui, theme, _bindings, done) => permissionPicker(tui, theme, currentId, done), {
    overlay: true, overlayOptions: { width: 76, maxHeight: '90%', anchor: 'center' },
  });
  if (!ctx.hasUI) throw Error('请使用 /permissions ask-for-approval|full-access|read-only。');
  const choices = PERMISSION_PRESETS.map(preset => `${preset.label}${currentId === preset.id ? ' (当前)' : ''} — ${preset.description}`);
  const selection = await ctx.ui.select('Permissions', choices);
  return PERMISSION_PRESETS[choices.indexOf(selection)]?.id;
}
export function approvalPicker(tui, theme, { owner, operation, options }, done) {
  let selected = 0;
  const paint = (color, text) => theme.fg(color, text);
  return {
    render(width) {
      if (width <= 0) return [''];
      const framed = width >= 24;
      const innerWidth = Math.max(1, width - (framed ? 4 : 0));
      const lines = [paint('accent', `执行批准 / Approval [${owner}]`)];
      const operationLines = new BoundedText(paint('muted', operation), 0, 0).render(innerWidth);
      const operationBudget = Math.max(4, Math.floor((tui.terminal?.rows ?? 24) / 2) - options.length - 4);
      lines.push('', ...operationLines.slice(0, operationBudget), ...(operationLines.length > operationBudget ? [paint('dim', `… +${operationLines.length - operationBudget} lines`)] : []), '');
      for (const [index, option] of options.entries()) {
        const focused = index === selected;
        const label = innerWidth >= 40 ? option.label : option.label.split(' / ')[0];
        const row = truncateToWidth(paint(focused ? 'accent' : 'text', `${focused ? '›' : ' '} ${index + 1}. ${label}`), innerWidth, '');
        lines.push(focused ? theme.bg?.('selectedBg', row + ' '.repeat(innerWidth - visibleWidth(row))) ?? row : row);
      }
      lines.push(paint('dim', innerWidth >= 36 ? '↑↓ 选择 · Enter 确认 · Esc 拒绝' : '↵选 Esc拒'));
      if (!framed) return lines.map(line => truncateToWidth(line, width, ''));
      return [paint('borderMuted', '╭' + '─'.repeat(width - 2) + '╮'), ...lines.map(line => {
        const content = truncateToWidth(line, innerWidth, '');
        return paint('borderMuted', '│ ') + content + ' '.repeat(innerWidth - visibleWidth(content)) + paint('borderMuted', ' │');
      }), paint('borderMuted', '╰' + '─'.repeat(width - 2) + '╯')];
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) { done('deny'); return; }
      if (matchesKey(data, 'enter')) { done(options[selected].id); return; }
      if (matchesKey(data, 'up')) selected = (selected + options.length - 1) % options.length;
      else if (matchesKey(data, 'down')) selected = (selected + 1) % options.length;
      else { const digit = Number(data); if (digit >= 1 && digit <= options.length) selected = digit - 1; else return; }
      tui.requestRender();
    },
    invalidate() {},
  };
}
export async function selectApproval(ui, { owner, operation, options, mode, signal }) {
  if (mode === 'tui' && ui.custom) return ui.custom((tui, theme, _bindings, done) => approvalPicker(tui, theme, { owner, operation, options }, done), {
    overlay: true, overlayOptions: { width: 76, maxHeight: '90%', anchor: 'center' },
  });
  if (!ui?.available) throw Error('Approval unavailable: no TUI or RPC dialog channel');
  const labels = options.map(option => option.label);
  const chosen = await ui.select(`执行批准 / Approval [${owner}]\n${operation}`, labels, { signal });
  return options[labels.indexOf(chosen)]?.id ?? 'deny';
}
// /subagent settings: a three-view overlay (menu -> model -> thinking) with
// Esc-navigated back steps, scroll windows for long model lists, and live
// summary refresh through the snapshot callback.
export function subagentSettingsPicker(tui, theme, options, done) {
  const paint = (color, text) => theme.fg(color, text);
  let view = 'menu', selected = 0, layer = null, pendingModel = null, notice = '';
  const menuRow = row => ({ ...row, disabled: row.disabled === true });
  const menuRows = () => {
    const set = options.snapshot();
    return [
      menuRow({ id: 'configure-session', label: '配置会话层 / Configure session layer', description: '仅本会话，不写文件' }),
      menuRow({ id: 'configure-global', label: '配置全局层 / Configure global layer', description: '写入 agent 目录，跨会话' }),
      menuRow({ id: 'clear-session', label: '清除会话层 / Clear session layer', disabled: !set.sessionSet }),
      menuRow({ id: 'clear-global', label: '清除全局层 / Clear global layer', disabled: !set.globalSet }),
      menuRow({ id: 'close', label: '关闭 / Close' }),
    ];
  };
  const modelRows = () => [{ id: null, label: '跟随主会话 / Inherit current model', description: '不覆盖模型，仅可调思考档' }, ...options.models.map(entry => ({ id: { provider: entry.provider, id: entry.id }, label: `${entry.provider}/${entry.id}`, description: entry.name }))];
  const thinkingRows = () => ['inherit', ...options.levelsFor(pendingModel).filter(level => level !== 'inherit')].map(level => ({ id: level, label: level === 'inherit' ? '跟随 / Inherit' : level }));
  const rows = () => view === 'menu' ? menuRows() : view === 'models' ? modelRows() : thinkingRows();
  return {
    render(width) {
      if (width <= 0) return [''];
      const framed = width >= 24;
      const innerWidth = Math.max(1, width - (framed ? 4 : 0));
      const snapshot = options.snapshot();
      const lines = view === 'menu'
        ? [paint('accent', '子代理配置 / Subagent settings'), '',
           ...new BoundedText(paint('muted', `生效（新 spawn）：${snapshot.effective}`), 0, 0).render(innerWidth),
           ...new BoundedText(paint('muted', `会话层（仅内存）：${snapshot.session}`), 0, 0).render(innerWidth),
           ...new BoundedText(paint('muted', `全局层：${snapshot.global}`), 0, 0).render(innerWidth)]
        : [paint('accent', view === 'models' ? `子代理模型 / Subagent model · ${layer === 'session' ? '会话层' : '全局层'}` : `思考强度 / Thinking level · ${layer === 'session' ? '会话层' : '全局层'}`),
           ...(view === 'thinking' ? [paint('dim', pendingModel ? `${pendingModel.provider}/${pendingModel.id}` : '跟随主会话 / Inherit current model')] : []), ''];
      if (notice) lines.push(paint('success', notice), '');
      const current = rows();
      const budget = Math.max(4, Math.floor((tui.terminal?.rows ?? 24) * 0.9) - lines.length - 4);
      const half = Math.max(1, Math.floor(budget / 2));
      const start = Math.max(0, Math.min(selected - half, current.length - budget));
      const visible = current.slice(start, start + budget);
      visible.forEach((row, index) => {
        const rowIndex = start + index;
        const focused = rowIndex === selected;
        const label = innerWidth >= 40 || !row.description ? row.label : row.label.split(' / ')[0];
        let title = `${focused ? '›' : ' '} ${rowIndex + 1}. ${label}`;
        if (row.description && innerWidth >= 40) title += `  ${row.description}`;
        if (row.disabled) title = paint('dim', title);
        const row0 = truncateToWidth(row.disabled ? title : paint(focused ? 'accent' : 'text', title), innerWidth, '');
        lines.push(focused && !row.disabled ? theme.bg?.('selectedBg', row0 + ' '.repeat(Math.max(0, innerWidth - visibleWidth(row0)))) ?? row0 : row0);
      });
      if (start > 0 || start + budget < current.length) lines.push(paint('dim', `↑↓ 滚动 · 共 ${current.length} 项`));
      lines.push(paint('dim', view === 'menu' ? (innerWidth >= 36 ? '↑↓ 选择 · Enter 确认 · Esc 关闭' : '↵选 Esc关') : (innerWidth >= 36 ? '↑↓ 选择 · Enter 确认 · Esc 返回' : '↵选 Esc返')));
      if (!framed) return lines.map(line => truncateToWidth(line, width, ''));
      return [paint('borderMuted', '╭' + '─'.repeat(width - 2) + '╮'), ...lines.map(line => {
        const content = truncateToWidth(line, innerWidth, '');
        return paint('borderMuted', '│ ') + content + ' '.repeat(Math.max(0, innerWidth - visibleWidth(content))) + paint('borderMuted', ' │');
      }), paint('borderMuted', '╰' + '─'.repeat(width - 2) + '╯')];
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) {
        if (view === 'menu') { done(); return; }
        if (view === 'thinking') { view = 'models'; } else { view = 'menu'; }
        selected = 0; tui.requestRender(); return;
      }
      const current = rows();
      if (matchesKey(data, 'enter')) {
        const row = current[selected];
        if (!row || row.disabled) return;
        if (view === 'menu') {
          if (row.id === 'close') { done(); return; }
          if (row.id === 'clear-session' || row.id === 'clear-global') {
            const target = row.id === 'clear-session' ? 'session' : 'global';
            Promise.resolve(options.clear(target)).then(() => { notice = target === 'session' ? '会话层已清除 / Session layer cleared' : '全局层已清除 / Global layer cleared'; tui.requestRender(); }).catch(() => { notice = '清除失败 / Clear failed'; tui.requestRender(); });
            return;
          }
          layer = row.id === 'configure-session' ? 'session' : 'global';
          view = 'models'; selected = 0; tui.requestRender(); return;
        }
        if (view === 'models') { pendingModel = row.id; view = 'thinking'; selected = 0; tui.requestRender(); return; }
        Promise.resolve(options.apply(layer, { model: pendingModel, thinking: row.id })).then(() => {
          notice = `已更新${layer === 'session' ? '会话层' : '全局层'} / Updated ${layer} layer`;
          view = 'menu'; selected = 0; tui.requestRender();
        }).catch(() => { notice = '保存失败 / Save failed'; tui.requestRender(); });
        return;
      }
      if (matchesKey(data, 'up')) selected = (selected + current.length - 1) % current.length;
      else if (matchesKey(data, 'down')) selected = (selected + 1) % current.length;
      else { const digit = Number(data); const index = digit - 1; if (!(digit >= 1 && digit <= 9) || index >= current.length || current[index].disabled) return; selected = index; }
      tui.requestRender();
    },
    invalidate() {},
  };
}
// RPC fallback: the same flow through standard sequential selects.
export async function configureSubagents(ctx, options) {
  if (ctx.mode === 'tui' && ctx.ui.custom) {
    return ctx.ui.custom((tui, theme, _bindings, done) => subagentSettingsPicker(tui, theme, options, done), {
      overlay: true, overlayOptions: { width: 76, maxHeight: '90%', anchor: 'center' },
    });
  }
  if (!ctx.hasUI) throw Error('Subagent settings need a TUI or RPC dialog channel');
  for (;;) {
    const snapshot = options.snapshot();
    const actions = ['配置会话层 / Configure session layer', '配置全局层 / Configure global layer', ...(snapshot.sessionSet ? ['清除会话层 / Clear session layer'] : []), ...(snapshot.globalSet ? ['清除全局层 / Clear global layer'] : []), '关闭 / Close'];
    const choice = await ctx.ui.select(`子代理配置 / Subagents\n生效（新 spawn）：${snapshot.effective}\n会话层（仅内存）：${snapshot.session}\n全局层：${snapshot.global}`, actions);
    if (choice === undefined || choice === '关闭 / Close') return;
    if (choice.includes('清除会话层')) { await options.clear('session'); ctx.ui.notify('会话子代理配置已清除 / Session subagent config cleared', 'info'); continue; }
    if (choice.includes('清除全局层')) { await options.clear('global'); ctx.ui.notify('全局子代理配置已清除 / Global subagent config cleared', 'info'); continue; }
    const layer = choice.includes('会话层') ? 'session' : 'global';
    const models = [{ id: null, label: '跟随主会话 / Inherit current model' }, ...options.models.map(entry => ({ id: { provider: entry.provider, id: entry.id }, label: `${entry.provider}/${entry.id} — ${entry.name}` }))];
    const pickedModel = await ctx.ui.select(`子代理模型 / Subagent model`, models.map(model => model.label));
    if (pickedModel === undefined) continue;
    const modelRef = models.find(model => model.label === pickedModel)?.id ?? null;
    const levels = ['inherit', ...options.levelsFor(modelRef).filter(level => level !== 'inherit')];
    const pickedLevel = await ctx.ui.select('思考强度 / Thinking level', levels);
    if (pickedLevel === undefined) continue;
    await options.apply(layer, { model: modelRef, thinking: pickedLevel });
    ctx.ui.notify(`子代理${layer === 'session' ? '会话' : '全局'}层已更新 / Updated`, 'info');
  }
}
export function renderToolCall(args, theme, label) {
  const summary = cleanTerminal(args.cmd ?? args.command ?? args.path ?? args.message ?? args.context ?? (args.session_id ? `session ${args.session_id}` : ''));
  return new BoundedText(theme.fg('toolTitle', `${label} ${summary.slice(0, 180)}`), 0, 0);
}
export function renderToolResult(output, { expanded, isPartial }, theme) {
  const execution = output.details?.execution ? output.details : undefined;
  const text = cleanTerminal(execution?.output ?? output.details?.display ?? output.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '');
  if (execution) {
    // Like Codex's exec cell, render the actual output; transport metadata stays
    // in the model observation and details, not in the visible output body.
    const lines = text.replace(/\n$/, '').split('\n');
    const limit = isPartial ? 2 : 4;
    const preview = expanded || lines.length <= limit * 2 ? lines : [...lines.slice(0, limit), `… +${lines.length - limit * 2} lines · Ctrl+T 展开`, ...lines.slice(-limit)];
    const status = isPartial || execution.timed_out || execution.cancelled || execution.signal ? ''
      : execution.running ? `运行中 · session ${execution.process_id}` : execution.exit_code ? `exit ${execution.exit_code}` : '';
    return new BoundedText([text ? preview.join('\n') : '', status ? theme.fg(execution.running ? 'muted' : 'warning', status) : ''].filter(Boolean).join('\n'), 0, 0);
  }
  const lines = text.split('\n');
  const display = expanded ? text : lines.slice(0, isPartial ? 4 : 8).join('\n') + (lines.length > 8 ? '\n… 展开查看 / expand for more' : '');
  return new BoundedText(theme.fg('toolOutput', display), 0, 0);
}
export async function showText(ctx, title, content) {
  if (ctx.mode !== 'tui') { ctx.ui.notify(`${title}\n${content}`, 'info'); return; }
  await ctx.ui.custom((tui, theme, _bindings, done) => {
    let offset = 0;
    return {
      render(width) {
        const all = new BoundedText(cleanTerminal(content), 0, 0).render(Math.max(1, width));
        const height = Math.max(1, Math.floor((tui.terminal.rows ?? 24) * 0.7) - 2);
        offset = Math.min(offset, Math.max(0, all.length - height));
        return [truncateToWidth(theme.fg('accent', title + ' · ↑↓ PgUp/PgDn · Esc'), width), ...all.slice(offset, offset + height)];
      },
      handleInput(data) {
        if (matchesKey(data, 'escape') || matchesKey(data, 'q')) done();
        else if (matchesKey(data, 'up')) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, 'down')) offset++;
        else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - 10);
        else if (matchesKey(data, 'pageDown')) offset += 10;
        tui.requestRender();
      }, invalidate() {},
    };
  }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '85%', anchor: 'center' } });
}
