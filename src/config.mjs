import { readFile } from 'node:fs/promises';
export const defaults = Object.freeze({
  approval: 'on-request', sandbox: 'workspace-write', network: false, concurrency: 16,
  maxDepth: 4, maxQueued: 1024, outputBytes: 24000, maxJobs: 128,
  shell: '/bin/bash', sandboxCommand: 'bwrap', lsp: [], mcpReadOnly: [],
});
export function validateConfig(input = {}) {
  const unknown = Object.keys(input).filter(key => !(key in defaults));
  if (unknown.length) throw Error(`Unknown Codex configuration: ${unknown.join(', ')}`);
  const value = { ...defaults, ...input };
  if (!['never', 'on-request', 'always'].includes(value.approval)) throw Error('Invalid approval policy');
  if (!['read-only', 'workspace-write', 'none'].includes(value.sandbox)) throw Error('Invalid sandbox');
  for (const [key, min, max] of [['concurrency', 1, 4096], ['maxDepth', 1, 64], ['maxQueued', 1, 100000], ['outputBytes', 1024, 1048576], ['maxJobs', 1, 4096]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw Error(`Invalid ${key}`);
  }
  if (typeof value.network !== 'boolean' || !Array.isArray(value.lsp) || !Array.isArray(value.mcpReadOnly)) throw Error('Invalid session modules');
  for (const key of ['shell', 'sandboxCommand']) if (typeof value[key] !== 'string' || !value[key]) throw Error(`Invalid ${key}`);
  for (const server of value.lsp) {
    if (!server.name || !Array.isArray(server.command) || !server.command.length || !server.command.every(x => typeof x === 'string')) throw Error('LSP requires an explicit name and argv command');
    if (!Array.isArray(server.extensions) || !server.extensions.every(x => typeof x === 'string')) throw Error('LSP requires extensions');
  }
  if (!value.mcpReadOnly.every(x => typeof x === 'string')) throw Error('Invalid mcpReadOnly');
  return Object.freeze(value);
}
export async function loadConfig(path) { return validateConfig(path ? JSON.parse(await readFile(path, 'utf8')) : {}); }
