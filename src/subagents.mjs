// Subagent model/thinking configuration: session layer (memory only, never
// persisted) over a global layer stored in the Pi agent directory. Influenced
// by Codex's spawn-time config layering in multi_agents.rs; the files stay
// limited to model selection and never carry permission or sandbox settings.
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const subagentsPath = agentDir => path.join(agentDir, 'pi-codex', 'subagents.json');

// A level is offered when the model's thinkingLevelMap does not map it to
// null; models without a map accept the full set like Pi's default selector.
export function supportedThinkingLevels(model) {
  const map = model?.thinkingLevelMap;
  if (!map) return [...THINKING_LEVELS];
  const levels = THINKING_LEVELS.filter(level => level === 'off' || map[level] !== null && map[level] !== undefined);
  return levels.length ? levels : ['off'];
}

function validThinking(value) {
  return value == null || value === 'inherit' || THINKING_LEVELS.includes(value);
}

export function validateSubagentConfig(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Subagent config must be an object');
  const { model, thinking } = value;
  if (!validThinking(thinking)) throw Error(`Invalid thinking level: ${thinking}`);
  if (model != null) {
    if (typeof model !== 'object' || typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id) throw Error('Subagent model requires provider and id');
    return { model: { provider: model.provider, id: model.id }, thinking: thinking ?? null };
  }
  return thinking ? { model: null, thinking } : null;
}

export async function readSubagentConfig(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return validateSubagentConfig(JSON.parse(raw)); }
  catch (error) { throw Error(`Invalid subagent config ${file}: ${error.message}`); }
}

export async function writeSubagentConfig(file, config) {
  const validated = validateSubagentConfig(config);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(validated, null, 2) ?? 'null', 'utf8');
  await rename(temporary, file);
  return validated;
}

export async function clearSubagentConfig(file) {
  await rm(file, { force: true });
  return null;
}
