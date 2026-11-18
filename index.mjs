import { Runtime } from './src/runtime.mjs';
import { loadConfig } from './src/config.mjs';
import { applyPromptSections, modeInstructions } from './src/prompt.mjs';
import { installUI, refreshStatus, selectPermission, selectPlanImplementation, renderToolCall, renderToolResult, showText, configureSubagents } from './src/ui.mjs';
import { execResult, truncateText, byteLength } from './src/exec-output.mjs';
import { PERMISSION_PRESETS, permissionPreset } from './src/permissions.mjs';
import { PLAN_IMPLEMENTATION_CODING_MESSAGE, extractProposedPlan, planUsageLabel } from './src/plan.mjs';
import { THINKING_LEVELS, clearSubagentConfig, subagentsPath, supportedThinkingLevels, writeSubagentConfig } from './src/subagents.mjs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readdir, stat } from 'node:fs/promises';
// Pi evaluates this entry file again on /reload and for every new or resumed session, but a
// process keeps the modules under src/ it has already loaded. After an update on disk the two
// no longer match, so say so up front instead of failing later on a missing export.
const LOADED_AT = Symbol.for('pi-codex-flavor.loaded-at');
globalThis[LOADED_AT] ??= Date.now();
async function updatedOnDisk() {
  const newest = async directory => {
    let latest = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      latest = Math.max(latest, entry.isDirectory() ? await newest(target) : (await stat(target)).ctimeMs);
    }
    return latest;
  };
  try { return await newest(new URL('./src/', import.meta.url)) > globalThis[LOADED_AT]; } catch { return false; }
}
export default async function codexFlavor(pi) {
  if (!('registerVirtualModel' in pi)) throw Error('pi-codex-flavor requires @earendil-works/pi-coding-agent 1.5.2');
  pi.registerFlag('codex-config', { type: 'string', description: 'Explicit trusted JSON session configuration for Pi Codex flavor' });
  const config = await loadConfig(pi.getFlag('codex-config'));
  let context, runtime, definitions;
  const requireRuntime = () => { if (!runtime) throw Error('Codex runtime is not initialized'); return runtime; };
  const getUI = () => context?.hasUI ? { available: true, mode: context.mode, select: (...a) => context.ui.select(...a), input: (...a) => context.ui.input(...a), confirm: (...a) => context.ui.confirm(...a), custom: (...a) => context.ui.custom?.(...a) } : { available: false };
  const seed = new Runtime({ root: process.cwd(), config, getContext: () => context, getUI, agentDir: getAgentDir() });
  const names = new Set(seed.tools().map(tool => tool.name));
  for (const tool of seed.tools()) pi.registerTool({ ...tool,
    execute: (...args) => { requireRuntime(); context = args[4] ?? context; return definitions.get(tool.name).execute(...args); },
    ...(tool.renderCall ? {} : { renderCall: (args, theme) => renderToolCall(args, theme, tool.label), renderResult: renderToolResult }),
  });
  pi.registerTool({
    name: 'bash', label: 'bash (controlled)', description: 'Compatibility command tool through Codex execution policy. Prefer exec_command and write_stdin.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
    renderCall: (args, theme) => renderToolCall(args, theme, 'bash'), renderResult: renderToolResult,
    execute: async (_id, params, signal, update) => {
      const output = await requireRuntime().executor.exec({ cmd: params.command, timeout_ms: params.timeout ? params.timeout * 1000 : undefined, yield_time_ms: 30000 }, 'root', signal, update);
      return execResult(output, config.outputBytes);
    },
  });
  names.add('bash');
  const start = async ctx => {
    if (runtime) { runtime.state.persist = () => {}; await runtime.close(); }
    context = ctx;
    runtime = await Runtime.create({ root: ctx.cwd, config, entries: ctx.sessionManager.getBranch(), getContext: () => context, getUI, agentDir: getAgentDir(),
      persist: (type, data) => pi.appendEntry(type, data),
      deliver: event => {
        if (event.status !== 'answered') return;
        pi.sendMessage({ customType: 'pi-codex-user-input', content: JSON.stringify(event), display: true, details: event }, { triggerTurn: true, deliverAs: 'steer' });
      },
      onChange: () => { if (context && runtime) refreshStatus(context, runtime); },
    });
    runtime.parentMessage = (owner, message) => pi.sendMessage({ customType: 'pi-codex-agent-message', content: `[${owner}] ${message}`, display: true }, { triggerTurn: true, deliverAs: 'steer' });
    definitions = new Map(runtime.tools('root', () => context).map(tool => [tool.name, tool]));
    installUI(ctx, runtime);
    // Like Codex's retained <collaboration_mode> developer fragment, re-inject the
    // Plan Mode instructions when a persisted session resumes already in Plan Mode.
    // The instructions are about 2k tokens; skip them when this branch still carries them.
    if (runtime.state.data.mode === 'plan' && !modeInContext(ctx, 'plan')) sendModeInstructions('plan');
  };
  const modeInContext = (ctx, mode) => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      if (branch[index].type === 'compaction') return false;
      if (branch[index].customType === 'pi-codex-mode') return branch[index].content === modeInstructions(mode);
    }
    return false;
  };
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI && await updatedOnDisk()) ctx.ui.notify('pi-codex-flavor 的文件在本进程加载后已更新；/reload 只重新加载入口文件，请重启 Pi 使更新完整生效。', 'warning');
    return start(ctx);
  });
  pi.on('session_tree', (_event, ctx) => start(ctx));
  pi.on('before_agent_start', (event, ctx) => {
    context = ctx;
    // Contribute replaceable sections instead of returning a forced systemPrompt: a
    // forced text freezes the rendering at this extension's chain position and Pi
    // projects it over every later contribution, which hid the built-in mcp_servers
    // section. Sections keep the native MCP context injection, skills handling, and
    // per-section diffs; with no MCP servers the mcp section never exists at all.
    applyPromptSections(event.systemPromptOptions, event.systemPrompt);
  });
  pi.on('agent_start', async (_event, ctx) => { context = ctx; await requireRuntime().scheduler.acquire('root', ctx.signal); refreshStatus(ctx, runtime); });
  pi.on('agent_end', () => { if (runtime) { runtime.scheduler.release('root'); refreshStatus(context, runtime); } });
  // Text from the latest low-level run; Plan Mode inspects it at settle time
  // the way Codex reads streamed <proposed_plan> items on TurnComplete.
  let lastRunText = '';
  pi.on('agent_end', event => {
    lastRunText = (event.messages ?? []).filter(m => m?.role === 'assistant')
      .map(m => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')))
      .join('\n');
  });
  pi.on('agent_settled', async (event, ctx) => {
    // Mirror Codex's maybe_prompt_plan_implementation: prompt once the run truly
    // finished, still in Plan Mode, with a proposed plan seen in the final run.
    if (event.aborted || !runtime || runtime.state.data.mode !== 'plan') return;
    if (!ctx.hasUI || ctx.hasPendingMessages?.()) return;
    const plan = extractProposedPlan(lastRunText);
    if (plan === null) return;
    runtime.state.setProposedPlan(plan);
    let choice;
    try { choice = await selectPlanImplementation(ctx, { planMarkdown: runtime.state.data.proposedPlan?.text, usageLabel: planUsageLabel(ctx.getContextUsage?.()) }); }
    catch { return; }
    if (choice === 'implement' || choice === 'fresh') pi.sendUserMessage(choice === 'fresh' ? '/codex-implement fresh' : '/codex-implement', { expandPromptTemplates: true });
  });
  pi.on('session_compact', () => {
    pi.sendMessage({ customType: 'pi-codex-continuity', content: 'Durable programming state after Pi compaction:\n' + JSON.stringify(requireRuntime().state.continuity()), display: false });
    // The summary replaces the earlier messages, the Plan Mode instructions among them.
    if (runtime.state.data.mode === 'plan') sendModeInstructions('plan');
  });
  pi.on('tool_call', async (event, ctx) => {
    if (names.has(event.toolName) || ['tool_search', 'codemode'].includes(event.toolName)) return;
    const hinted = pi.getAllTools?.().find(tool => tool.name === event.toolName)?.annotations?.readOnlyHint === true;
    try { await requireRuntime().guardExternal(event.toolName, 'root', ctx.signal, hinted); }
    catch (error) { return { block: true, reason: error.message }; }
  });
  pi.on('tool_result', (event) => {
    if (names.has(event.toolName) || event.toolName === 'tool_search') return;
    // External tool output keeps a head and a tail like Codex's model-facing
    // truncation instead of a head-only slice that hides late errors.
    return { content: event.content.map(c => c.type === 'text' && byteLength(c.text) > config.outputBytes ? { ...c, text: truncateText(c.text, { unit: 'bytes', value: config.outputBytes }) } : c) };
  });
  pi.on('user_bash', async (event, ctx) => {
    try {
      const response = await requireRuntime().executor.capture([config.shell, '--noprofile', '--norc', '-c', event.command], { owner: 'root', signal: ctx.signal, description: event.command });
      return { result: { output: response.output, exitCode: response.exit_code ?? undefined, cancelled: response.cancelled, truncated: response.dropped_bytes > 0 } };
    } catch (error) { return { result: { output: error.message, exitCode: 1, cancelled: false, truncated: false } }; }
  });
  pi.on('session_shutdown', async () => { await runtime?.close(); });
  const permissionsCommand = {
    description: 'Set permissions: Ask for Approval, Full Access or Read-Only',
    getArgumentCompletions: prefix => PERMISSION_PRESETS.filter(preset => preset.id.startsWith(prefix.toLowerCase())).map(preset => ({ value: preset.id, label: preset.label, description: preset.description })),
    handler: async (args, ctx) => {
      context = ctx;
      try {
        const active = requireRuntime();
        if (ctx.isIdle && !ctx.isIdle()) throw Error('请先停止当前任务，再切换权限。');
        active.assertPermissionChangeIdle();
        const input = args.trim();
        if (input && !permissionPreset(input)) throw Error('用法：/permissions ask-for-approval|full-access|read-only');
        const selected = input || await selectPermission(ctx, active.policy.preset.id);
        if (!selected || active.policy.preset.id === permissionPreset(selected)?.id) return;
        const preset = active.setPermission(selected);
        pi.sendMessage({ customType: 'pi-codex-permission', content: `The user selected ${preset.label}. Effective permissions: ${JSON.stringify(preset.settings)}. Plan mode and reviewer restrictions still apply.`, display: false }, { triggerTurn: false });
        refreshStatus(ctx, active);
        ctx.ui.notify(`Permissions: ${preset.label}`, 'info');
      } catch (error) { ctx.ui.notify(error.message, 'error'); }
    },
  };
  // Codex switches collaboration modes with a retained <collaboration_mode>
  // developer fragment; this suite injects the same tagged block as a custom
  // context message when the user changes modes.
  const sendModeInstructions = mode => {
    pi.sendMessage({ customType: 'pi-codex-mode', content: modeInstructions(mode), display: false }, { triggerTurn: false });
  };
  pi.registerCommand('permissions', permissionsCommand);
  pi.registerCommand('plan', { description: 'Toggle Plan Mode (read-only planning with <proposed_plan>); /plan <text> switches to Plan Mode and submits the text', handler: async (args, ctx) => {
    context = ctx;
    try {
      const active = requireRuntime();
      if (ctx.isIdle && !ctx.isIdle()) throw Error('请先停止当前任务，再切换模式。');
      const text = args.trim();
      const current = active.state.data.mode;
      const next = text || current !== 'plan' ? 'plan' : 'execute';
      if (next !== current) {
        await active.setMode(next);
        sendModeInstructions(next);
        refreshStatus(ctx, active);
        ctx.ui.notify(next === 'plan' ? 'Plan Mode 已开启：工作区只读，对话产出 <proposed_plan> 计划。' : 'Plan Mode 已关闭，回到执行模式。', 'info');
      }
      if (text) pi.sendUserMessage(text);
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  } });
  pi.registerCommand('codex-implement', { description: 'Implement the approved plan; append "fresh" to start a new session carrying the plan', handler: async (args, ctx) => {
    context = ctx;
    try {
      const active = requireRuntime();
      if (!active.state.data.proposedPlan?.text?.trim()) throw Error('No approved plan available');
      if (args.trim() === 'fresh') {
        if (ctx.isIdle && !ctx.isIdle()) throw Error('请先停止当前任务，再实施计划。');
        const plan = active.state.data.proposedPlan;
        const parentSession = ctx.sessionManager.getSessionFile?.();
        const carried = plan.text;
        await ctx.newSession({
          ...(parentSession ? { parentSession } : {}),
          setup: sm => { sm.appendMessage({ role: 'custom', customType: 'pi-codex-approved-plan', content: carried, display: false, timestamp: Date.now() }); },
          withSession: async session => { await session.sendUserMessage(PLAN_IMPLEMENTATION_CODING_MESSAGE); },
        });
        return;
      }
      if (active.state.data.mode === 'plan') {
        if (ctx.isIdle && !ctx.isIdle()) throw Error('请先停止当前任务，再实施计划。');
        await active.setMode('execute');
        sendModeInstructions('execute');
        refreshStatus(ctx, active);
      }
      pi.sendUserMessage(PLAN_IMPLEMENTATION_CODING_MESSAGE);
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  } });
  pi.registerCommand('codex-agents', { description: 'Browse agent threads without model requests', handler: async (_args, ctx) => {
    const threads = Object.values(requireRuntime().state.data.threads);
    if (!threads.length) { ctx.ui.notify('No agent threads', 'info'); return; }
    const labels = threads.map(t => `${t.id} · ${t.status} · ${t.role}`);
    const selection = await ctx.ui.select('代理线程 / Agent threads', labels); if (selection === undefined) return;
    const thread = threads[labels.indexOf(selection)]; if (thread) await showText(ctx, thread.id, JSON.stringify(thread, null, 2));
  } });
  pi.registerCommand('codex-questions', { description: 'Inspect pending and answered questions', handler: async (_args, ctx) => showText(ctx, '问题队列 / Questions', JSON.stringify(requireRuntime().state.data.questions, null, 2)) });
  pi.registerCommand('codex-approvals', { description: 'Inspect execution approvals, session cache hits and prefix rules separately from user decisions', handler: async (_args, ctx) => {
    const active = requireRuntime();
    const summary = { approvals: active.state.data.approvals, sessionApproved: active.approvals.session.size, prefixRules: active.approvals.rules.rules, prefixRulesFile: active.approvals.rules.file, ...(active.approvals.rules.loadError ? { prefixRulesError: active.approvals.rules.loadError } : {}) };
    await showText(ctx, '执行审批 / Approvals', JSON.stringify(summary, null, 2));
  } });
  // /subagent: configure the model and thinking level used by newly spawned
  // agents. The session layer is memory-only; the global layer persists under
  // the Pi agent directory. Session overrides global, and both fall back to
  // inheriting the spawning context (Codex layers spawn-time agent config the
  // same way in multi_agents.rs).
  const describeSubagentConfig = config => config
    ? [config.model ? `model ${config.model.provider}/${config.model.id}` : null, config.thinking ? `thinking ${config.thinking}` : null].filter(Boolean).join(', ') || '已设置但无字段' : '未设置'
  const announceSubagentConfig = ctx => {
    const resolved = requireRuntime().resolveSubagent(ctx);
    pi.sendMessage({ customType: 'pi-codex-subagent', content: `Subagent configuration for newly spawned agents: ${resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : 'inherit'} (thinking ${resolved.thinking}, source ${resolved.source}${resolved.note ? `; ${resolved.note}` : ''}). Session config: ${describeSubagentConfig(runtime.subagentSession)}; global config: ${describeSubagentConfig(runtime.subagentGlobal)}.`, display: false }, { triggerTurn: false });
  };
  pi.registerCommand('subagent', { description: 'Open the subagent settings view: pick session (memory-only) or global (persisted) model and thinking. Direct form: /subagent session|global [provider/model [thinking]] · /subagent clear session|global', handler: async (args, ctx) => {
    context = ctx;
    try {
      const active = requireRuntime();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [scope, reference, thinkingArg] = parts;
      if (!scope) {
        if (!ctx.hasUI) {
          const resolved = active.resolveSubagent(ctx);
          await showText(ctx, '子代理配置 / Subagents', [
            `生效（新 spawn）：${resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : '跟随主会话'} · thinking ${resolved.thinking} · 来源 ${resolved.source}${resolved.note ? ` · ${resolved.note}` : ''}`,
            `会话层（仅内存）：${describeSubagentConfig(active.subagentSession)}`,
            `全局层（${subagentsPath(getAgentDir())}）：${describeSubagentConfig(active.subagentGlobal)}`,
            '无交互界面时可用参数形式：/subagent session|global [provider/model [off|minimal|low|medium|high|xhigh|max|inherit]] · /subagent clear session|global',
          ].join('\n'));
          return;
        }
        await configureSubagents(ctx, {
          snapshot: () => {
            const resolved = active.resolveSubagent(ctx);
            return {
              effective: `${resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : '跟随主会话'} · thinking ${resolved.thinking} · 来源 ${resolved.source}${resolved.note ? ` · ${resolved.note}` : ''}`,
              session: describeSubagentConfig(active.subagentSession),
              sessionSet: !!active.subagentSession,
              global: describeSubagentConfig(active.subagentGlobal),
              globalSet: !!active.subagentGlobal,
            };
          },
          models: ctx.modelRegistry?.getAvailable?.() ?? [],
          levelsFor: modelRef => supportedThinkingLevels(modelRef && ctx.modelRegistry?.find ? (ctx.modelRegistry.find(modelRef.provider, modelRef.id) ?? ctx.model) : ctx.model),
          apply: async (layer, { model, thinking }) => {
            if (thinking !== 'inherit' && !THINKING_LEVELS.includes(thinking)) throw Error(`思考强度可选 / Thinking options: inherit, ${THINKING_LEVELS.join(', ')}`);
            const value = model || (thinking && thinking !== 'inherit') ? { model, thinking } : null;
            if (layer === 'global') { await writeSubagentConfig(subagentsPath(getAgentDir()), value); await active.reloadSubagentGlobal(); }
            else active.subagentSession = value;
            announceSubagentConfig(ctx);
          },
          clear: async layer => {
            if (layer === 'session') active.subagentSession = null;
            else { await clearSubagentConfig(subagentsPath(getAgentDir())); await active.reloadSubagentGlobal(); }
            announceSubagentConfig(ctx);
          },
        });
        return;
      }
      if (scope === 'clear') {
        if (parts[1] === 'session') active.subagentSession = null;
        else if (parts[1] === 'global') { await clearSubagentConfig(subagentsPath(getAgentDir())); await active.reloadSubagentGlobal(); }
        else throw Error('用法：/subagent clear session|global');
        announceSubagentConfig(ctx);
        ctx.ui.notify(parts[1] === 'session' ? '会话子代理配置已清除 / Session subagent config cleared' : '全局子代理配置已清除 / Global subagent config cleared', 'info');
        return;
      }
      if (scope !== 'session' && scope !== 'global') throw Error('用法：/subagent [session|global [provider/model [thinking]]] 或 /subagent clear session|global');
      const separator = reference ? reference.indexOf('/') : -1;
      if (separator <= 0) throw Error('模型格式 / Model format: provider/model-id');
      const found = ctx.modelRegistry?.find?.(reference.slice(0, separator), reference.slice(separator + 1));
      if (!found) throw Error(`未知模型 / Unknown model: ${reference}`);
      const model = { provider: found.provider, id: found.id };
      const thinking = thinkingArg ?? 'inherit';
      if (thinking !== 'inherit' && !THINKING_LEVELS.includes(thinking)) throw Error(`思考强度可选 / Thinking options: inherit, ${THINKING_LEVELS.join(', ')}`);
      const value = model || (thinking && thinking !== 'inherit') ? { model, thinking } : null;
      if (scope === 'global') { await writeSubagentConfig(subagentsPath(getAgentDir()), value); await active.reloadSubagentGlobal(); }
      else active.subagentSession = value;
      announceSubagentConfig(ctx);
      ctx.ui.notify(`${scope === 'session' ? '会话' : '全局'}子代理配置已更新 / Subagent ${scope} config updated`, 'info');
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  } });
  pi.registerCommand('codex-state', { description: 'Browse tasks, decisions and verification without model requests', handler: async (_args, ctx) => showText(ctx, 'Codex state', JSON.stringify(requireRuntime().state.summary(), null, 2)) });
  pi.registerCommand('codex-review', { description: 'Browse workspace or staged diff; optionally return a review comment', handler: async (args, ctx) => {
    const target = args.trim() === 'staged' ? 'staged' : 'workspace';
    try {
      const diff = await requireRuntime().reviewDiff({ target }, 'root', ctx.signal); await showText(ctx, `Review · ${target}`, diff.output);
      const action = ctx.hasUI ? await ctx.ui.select('审阅 / Review', ['完成 / Done', '回传评论 / Return comment']) : undefined;
      if (action === '回传评论 / Return comment') { const comment = await ctx.ui.input('审阅评论 / Review comment'); if (comment?.trim()) pi.sendMessage({ customType: 'pi-codex-review', content: comment, display: true }, { triggerTurn: true }); }
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  } });
}
