import { access, cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
import { hash } from '../src/util.mjs';
import codexFlavor from '../index.mjs';
import { CORE_PROMPT, AGENT_PROMPT, REVIEW_PROMPT, PLAN_MODE_PROMPT, DEFAULT_MODE_PROMPT } from '../src/prompt.mjs';
import { defaults } from '../src/config.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(), 'pi-codex-release-'));
const output = path.join(root, 'release'); await mkdir(output, { recursive: true });
try {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const entry of metadata.files) {
    await mkdir(path.dirname(path.join(stage, entry)), { recursive: true });
    await cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
  }
  delete metadata.scripts; delete metadata.devDependencies;
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8' });
  if (pack.status !== 0) throw Error(pack.stderr);
  const parsedPack = JSON.parse(pack.stdout);
  const item = Array.isArray(parsedPack) ? parsedPack[0] : Object.values(parsedPack)[0];
  const forbidden = item.files.filter(f => /(^|\/)(test|tests|scripts|docs|fixtures|node_modules)(\/|$)/i.test(f.path) || (f.path.startsWith('third_party/') && !metadata.files.includes(f.path)));
  if (forbidden.length) throw Error('Development files reached runtime package: ' + forbidden.map(f => f.path).join(', '));
  const target = path.join(output, item.filename); const data = await readFile(target);
  await writeFile(path.join(output, 'SHA256SUMS'), `${hash(data)}  ${item.filename}\n`);
  await cp(path.join(root, 'package-lock.json'), path.join(output, 'development-package-lock.json'));
  await cp(path.join(root, 'docs/capabilities.md'), path.join(output, 'capabilities.md'));
  try {
    await access(path.join(root, 'docs/validation-report.md'));
    await cp(path.join(root, 'docs/validation-report.md'), path.join(output, 'validation-report.md'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await cp(path.join(root, 'docs/prompt-port.md'), path.join(output, 'prompt-port.md'));
  await cp(path.join(root, 'docs/prompt-adaptations.json'), path.join(output, 'prompt-adaptations.json'));
  let promptDiff = '';
  for (const [original, adapted] of [['base-instructions.md', 'core.md'], ['subagent-instructions.md', 'agent.md'], ['review-rubric.md', 'reviewer.md'], ['collaboration-plan-template.md', 'plan-mode.md'], ['collaboration-default-template.md', 'default-mode.md']]) {
    promptDiff += createTwoFilesPatch(`codex-current/${original}`, `src/prompts/${adapted}`, await readFile(path.join(root, 'third_party/codex-current', original), 'utf8'), await readFile(path.join(root, 'src/prompts', adapted), 'utf8')) + '\n';
  }
  await writeFile(path.join(output, 'prompt-port.diff'), promptDiff);
  let snapshot = '# Pi Codex Flavor ' + metadata.version + ' — 实际提示词全文\n\n核心追加到 Pi、用户和其他扩展原有系统提示之后，不替换它们。来源固定为 2026-11-12 的公开 Codex 提交 c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee，GPT-6.1-Sol 指令模板及同一提交的协作模式模板；并非未公开会话指令的导出。\n\n## 默认核心\n\n' + CORE_PROMPT + '\n\n## 子代理共用说明\n\n' + AGENT_PROMPT;
  snapshot += '\n\n角色附加文本：Delegated role: <worker|scout|reviewer|tester>.\n只读线程：Read-only: report findings; do not change files.\n其他线程：Other agents share this workspace. Preserve their work; delegate further when useful.\n\n## 显式 reviewer 或 review 工作流追加\n\n' + REVIEW_PROMPT;
  for (const name of ['implement', 'debug', 'refactor', 'test', 'review']) snapshot += '\n\n## 按需工作流：' + name + '\n\n' + await readFile(path.join(root, 'workflows', name + '.md'), 'utf8');
  snapshot += '\n\n## 计划模式指令（/plan 进入时注入）\n\n' + PLAN_MODE_PROMPT + '\n\n## 默认模式指令（退出计划模式时注入）\n\n' + DEFAULT_MODE_PROMPT;
  snapshot += '\n\n## 必要上下文事件\n\n用户明确切换权限时写入隐藏的 pi-codex-permission 事件（所选权限及有效设置），不触发模型调用；/plan 切换计划/执行模式时写入隐藏的 pi-codex-mode 事件，携带 <collaboration_mode> 标签包裹的模式指令。异步问题的明确回答通过关联 request_id 的 user_input_response 到达；代理消息带来源；Pi 压缩后用 pi-codex-continuity 补充任务、决策、问题、验证和线程引用。工具说明及 schema 见同目录 tool-declarations.json。纯 UI 状态、菜单浏览和工具卡折叠不注入模型上下文。\n';
  await writeFile(path.join(output, 'prompts.md'), snapshot);
  const preview = { command: 'pi install "$HOME/.pi/agent/extensions/pi-codex-flavor"', packages: { operation: 'append-if-absent', value: '$HOME/.pi/agent/extensions/pi-codex-flavor' }, rollback: { command: 'pi remove "$HOME/.pi/agent/extensions/pi-codex-flavor"', operation: 'remove-this-value-only' }, notes: 'Preview only. Resolve HOME on the target machine. Extension folders live under ~/.pi/agent/extensions/; keep provider, keys, prompts, shortcuts, theme and every other existing setting.' };
  await writeFile(path.join(output, 'config-merge.preview.json'), JSON.stringify(preview, null, 2) + '\n');
  const declarations = [];
  await codexFlavor({ registerVirtualModel() {}, registerFlag() {}, getFlag() {}, on() {}, registerCommand() {},
    registerTool: ({ name, description, parameters }) => declarations.push({ name, description, parameters }),
  });
  await writeFile(path.join(output, 'tool-declarations.json'), JSON.stringify(declarations, null, 2) + '\n');
  const report = { name: metadata.name, version: metadata.version, archive: item.filename, sha256: hash(data), compressedBytes: data.length, unpackedBytes: item.unpackedSize,
    files: item.files.map(f => f.path), runtimeDependencies: metadata.dependencies, peers: metadata.peerDependencies,
    developmentFilesIncluded: false, installScripts: false,
    defaultToolCount: declarations.length, toolSchemaBytes: Buffer.byteLength(JSON.stringify(declarations)), corePromptBytes: Buffer.byteLength(CORE_PROMPT), agentPromptBytes: Buffer.byteLength(AGENT_PROMPT), onDemandReviewPromptBytes: Buffer.byteLength(REVIEW_PROMPT), planModePromptBytes: Buffer.byteLength(PLAN_MODE_PROMPT), defaultModePromptBytes: Buffer.byteLength(DEFAULT_MODE_PROMPT), promptSourceCommit: 'c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee',
    defaultBackgroundProcesses: 0, defaultLspTools: defaults.lsp.length, maxExecutionSlots: defaults.concurrency, defaultDelegationDepth: defaults.maxDepth };
  await writeFile(path.join(output, 'package-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ archive: target, sha256: report.sha256, compressedBytes: data.length, developmentFilesIncluded: false }, null, 2));
} finally { await rm(stage, { recursive: true, force: true }); }
