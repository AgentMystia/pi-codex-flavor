import { readFileSync } from 'node:fs';
// Adapted from the current public Codex GPT-6.1-Sol instructions; see third_party/codex-current/SOURCE.json and NOTICE.
export const CORE_PROMPT = readFileSync(new URL('./prompts/core.md', import.meta.url), 'utf8').trim();
export const REVIEW_PROMPT = readFileSync(new URL('./prompts/reviewer.md', import.meta.url), 'utf8').trim();
export const AGENT_PROMPT = readFileSync(new URL('./prompts/agent.md', import.meta.url), 'utf8').trim();
// Skill-usage guidance is injected only when the session actually has skills;
// Pi marks that with a <skills> section in the assembled system prompt.
export const SKILLS_PROMPT = readFileSync(new URL('./prompts/skills.md', import.meta.url), 'utf8').trim();
// Collaboration-mode templates adapted from the pinned Codex source; see
// third_party/codex-current/collaboration-{plan,default}-template.md and docs/prompt-adaptations.json.
export const PLAN_MODE_PROMPT = readFileSync(new URL('./prompts/plan-mode.md', import.meta.url), 'utf8').trim();
export const DEFAULT_MODE_PROMPT = readFileSync(new URL('./prompts/default-mode.md', import.meta.url), 'utf8').trim();
// Codex injects mode instructions as a <collaboration_mode> developer fragment;
// this suite sends the same tagged block as a custom context message.
export const modeInstructions = mode => `<collaboration_mode>\n${mode === 'plan' ? PLAN_MODE_PROMPT : DEFAULT_MODE_PROMPT}\n</collaboration_mode>`;
// The core reaches the model as a replaceable prompt section instead of a forced
// whole-prompt text: Pi diffs sections against what the model already has, so unchanged
// turns add zero tokens, later extensions (the built-in mcp_servers section, other
// injectors) still reach the model, and a changed section costs only its own patch.
// Pi loads built-in extensions after discovered ones, and a forced prompt freezes the
// rendering at this extension's position in the handler chain — the reason sections are
// required for native MCP context to compose with this suite.
export const CODEX_CORE_SECTION = 'codex_core';
export const CODEX_SKILLS_SECTION = 'codex_skills';
const MCP_SERVERS_SECTION_BLOCK = /[ \t]*<mcp_servers>[\s\S]*?<\/mcp_servers>\n?/g;
export function applyPromptSections(options, rendered) {
  options.sections[CODEX_CORE_SECTION] = CORE_PROMPT;
  // Skill-usage guidance is injected only when the session actually has skills;
  // Pi marks that with a <skills> section in the assembled system prompt.
  if (rendered.includes('<skills>')) options.sections[CODEX_SKILLS_SECTION] = SKILLS_PROMPT;
}
export function composePrompt(base) {
  let prompt = base.includes(CORE_PROMPT) ? base : base + '\n\n' + CORE_PROMPT;
  if (base.includes('<skills>') && !prompt.includes(SKILLS_PROMPT)) prompt += '\n\n' + SKILLS_PROMPT;
  return prompt;
}
export function composeAgentPrompt(base, role, readOnly) {
  // Descendants run on the suite's own tool set without codemode, tool_search, or MCP
  // tools, so the main session's mcp_servers section would advertise unreachable tools.
  const scoped = base.replace(MCP_SERVERS_SECTION_BLOCK, '').trimEnd();
  const roleText = 'Delegated role: ' + role + '. ' + (readOnly ? 'Read-only: report findings; do not change files.' : 'Other agents share this workspace. Preserve their work; delegate further when useful.');
  return composePrompt(scoped) + '\n\n' + AGENT_PROMPT + '\n\n' + roleText + (role === 'reviewer' ? '\n\n' + REVIEW_PROMPT : '');
}
