// Session-scoped execution approvals, ported from the pinned Codex source at
// commit c0cc9fc (core/src/tools/sandboxing.rs with_cached_approval +
// UnifiedExecApprovalKey, protocol approvals.rs ExecPolicyAmendment, and
// core/src/exec_policy.rs BANNED_PREFIX_SUGGESTIONS). See
// third_party/codex-current/SOURCE.json for provenance.
//
// Semantics follow Codex: an ApprovedForSession decision is remembered in an
// in-memory per-runtime store keyed by the canonicalized command plus cwd and
// sandbox mode; hits skip the dialog. Denials and cancellations are never
// cached. Prefix allow rules are the persistent execpolicy layer: they live in
// <agentDir>/pi-codex/execpolicy.json and auto-allow matching commands.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const execPolicyPath = agentDir => path.join(agentDir, 'pi-codex', 'execpolicy.json');

// Verbatim port of BANNED_PREFIX_SUGGESTIONS: interpreter and package-manager
// wrappers whose prefix rules would silently allow arbitrary code execution.
const BANNED_PREFIXES = [
  ['/bin/bash'], ['/bin/bash', '-c'], ['/bin/bash', '-lc'],
  ['/bin/sh'], ['/bin/sh', '-c'], ['/bin/sh', '-lc'],
  ['/bin/zsh'], ['/bin/zsh', '-c'], ['/bin/zsh', '-lc'],
  ['Rscript'], ['bash'], ['bash', '-c'], ['bash', '-lc'],
  ['bun'], ['bun', '-e'], ['bun', 'run'],
  ['cmd'], ['cmd', '/c'], ['cmd', '/k'],
  ['cmd.exe'], ['cmd.exe', '/c'], ['cmd.exe', '/k'],
  ['dash'], ['dash', '-c'], ['deno'], ['deno', 'eval'], ['env'],
  ['fish'], ['fish', '-c'], ['git'], ['julia'], ['julia', '-e'],
  ['ksh'], ['ksh', '-c'], ['lua'], ['lua', '-e'],
  ['node'], ['node', '-e'], ['nodejs'], ['nodejs', '-e'],
  ['npm', 'run'], ['osascript'], ['perl'], ['perl', '-e'],
  ['php'], ['php', '-r'], ['pnpm', 'run'],
  ['powershell'], ['powershell', '-Command'], ['powershell', '-EncodedCommand'], ['powershell', '-File'], ['powershell', '-c'],
  ['powershell.exe'], ['powershell.exe', '-Command'], ['powershell.exe', '-EncodedCommand'], ['powershell.exe', '-File'], ['powershell.exe', '-c'],
  ['pwsh'], ['pwsh', '-Command'], ['pwsh', '-EncodedCommand'], ['pwsh', '-File'], ['pwsh', '-c'], ['pwsh', '-e'], ['pwsh', '-ec'], ['pwsh', '-f'],
  ['py'], ['py', '-3'], ['pypy'], ['pypy3'],
  ['python'], ['python', '-'], ['python', '-c'],
  ['python3'], ['python3', '-'], ['python3', '-c'], ['pyw'],
  ['rm'], ['ruby'], ['ruby', '-e'],
  ['sh'], ['sh', '-c'], ['sh', '-lc'], ['sudo'],
  ['yarn', 'run'], ['zsh'], ['zsh', '-c'], ['zsh', '-lc'],
].map(prefix => Object.freeze(prefix));
Object.freeze(BANNED_PREFIXES);

export function bannedPrefix(prefix) {
  return BANNED_PREFIXES.some(banned => banned.length === prefix.length && banned.every((token, index) => token === prefix[index]));
}

// Codex canonicalizes argv for cache matching, keeping the exact script text
// for complex shell commands. pi-codex always runs a shell with the raw cmd
// string, so that string is the stable canonical form.
export const canonicalCommand = command => command;

// Split on whitespace without any quote handling; the same tokenizer runs on
// both sides (suggestion and later matching), so quoted arguments stay
// consistent. Commands containing shell operators never yield a prefix.
const SHELL_METACHARACTERS = /[;&|<>()\r\n`\\$]/;
export function commandTokens(command) {
  return String(command ?? '').trim().split(/\s+/).filter(Boolean);
}

// Port of try_derive_execpolicy_amendment_for_prompt_rules' shape: a prefix is
// offered only for a single plain command, never for shell pipelines or
// scripts. As a deliberate tightening over Codex's exact-length banned check,
// commands whose leading tokens match a banned sequence (bash -c …, sudo …,
// env …, interpreters) never offer a prefix either.
export function suggestPrefix(command) {
  const text = String(command ?? '').trim();
  if (!text || SHELL_METACHARACTERS.test(text)) return null;
  const tokens = commandTokens(text);
  if (!tokens.length) return null;
  if (BANNED_PREFIXES.some(banned => banned.length <= tokens.length && banned.every((token, index) => tokens[index] === token))) return null;
  return tokens;
}

function validRule(rule) {
  return rule && typeof rule === 'object' && Array.isArray(rule.prefix) && rule.prefix.length
    && rule.prefix.every(token => typeof token === 'string' && token) && typeof rule.escalated === 'boolean';
}

// The persistent prefix-rule store (the pi-codex counterpart of Codex's
// execpolicy.toml allow rules). Rules additionally record the escalation mode
// they were granted in, a deliberate pi-side tightening over Codex's global
// command matching.
export class PrefixRules {
  constructor(file) { this.file = file; this.rules = []; this.loadError = null; }
  async load() {
    this.loadError = null;
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') { this.rules = []; return this; } throw error; }
    try {
      const data = JSON.parse(raw);
      const rules = Array.isArray(data?.prefixRules) ? data.prefixRules : [];
      this.rules = rules.filter(validRule);
      if (this.rules.length !== rules.length) this.loadError = 'ignored invalid prefix rules';
      return this;
    } catch (error) { this.loadError = error.message; this.rules = []; return this; }
  }
  matches(tokens, escalated) {
    return this.rules.some(rule => rule.escalated === escalated
      && tokens.length >= rule.prefix.length && rule.prefix.every((token, index) => tokens[index] === token));
  }
  async add(prefix, escalated) {
    if (bannedPrefix(prefix)) throw Error('This prefix cannot be allowed');
    this.rules.push({ prefix: [...prefix], escalated: !!escalated });
    await this.save();
    return this.rules.length;
  }
  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, prefixRules: this.rules }, null, 2), 'utf8');
    await rename(temporary, this.file);
  }
}

// The in-memory session approval cache (Codex's tool_approvals store keyed by
// ApprovalCacheKey). It never touches disk and dies with the runtime.
export class SessionApprovals {
  constructor() { this.approved = new Set(); }
  static key(descriptor) {
    if (descriptor.kind === 'exec') return JSON.stringify(['exec', canonicalCommand(descriptor.command), descriptor.cwd ?? '', !!descriptor.escalated]);
    if (descriptor.kind === 'external') return JSON.stringify(['external', descriptor.name]);
    if (descriptor.kind === 'files') return JSON.stringify(['files', ...[...descriptor.paths].sort()]);
    return null;
  }
  has(descriptor) { const key = SessionApprovals.key(descriptor); return key != null && this.approved.has(key); }
  add(descriptor) { const key = SessionApprovals.key(descriptor); if (key != null) this.approved.add(key); }
  get size() { return this.approved.size; }
}

// Dialog option set in Codex label order: approve, approve for this session,
// approve a command prefix (persistent), deny. The prefix option only appears
// when a safe prefix can be derived for an exec command.
export function approvalOptions(descriptor) {
  const options = [
    { id: 'once', label: '允许 / Yes, proceed' },
    { id: 'session', label: '允许，且本会话不再询问此命令 / Yes, and don\'t ask again for this command in this session' },
  ];
  const prefix = descriptor?.kind === 'exec' ? suggestPrefix(descriptor.command) : null;
  if (prefix) options.push({ id: 'prefix', label: `允许，且不再询问以此开头的命令：${prefix.join(' ')} / Yes, and don't ask again for commands that start with \`${prefix.join(' ')}\``, prefix });
  options.push({ id: 'deny', label: '拒绝 / No' });
  return options;
}

// Facade owned by the runtime: loads the persistent rules once and exposes the
// three-level adjudication used by Policy.authorize.
export class Approvals {
  constructor({ agentDir }) {
    this.rules = new PrefixRules(execPolicyPath(agentDir));
    this.session = new SessionApprovals();
  }
  async load() { await this.rules.load(); return this; }
  prefixAllowed(descriptor) {
    if (descriptor?.kind !== 'exec') return false;
    // A rule vouches for one plain command, the only shape a prefix is ever suggested for.
    // Text the shell would chain, redirect or substitute goes back to the user.
    const command = String(descriptor.command ?? '').trim();
    if (!command || SHELL_METACHARACTERS.test(command)) return false;
    return this.rules.matches(commandTokens(command), descriptor.escalated);
  }
  async decide(decision, descriptor, option) {
    if (decision !== 'approved') return decision;
    if (option?.id === 'session') this.session.add(descriptor);
    if (option?.id === 'prefix') await this.rules.add(option.prefix, descriptor.escalated);
    return decision;
  }
}
