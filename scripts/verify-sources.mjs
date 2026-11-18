import { readFile } from 'node:fs/promises';
import { hash } from '../src/util.mjs';
const manifest = JSON.parse(await readFile(new URL('../third_party/codex/SOURCE.json', import.meta.url), 'utf8'));
for (const item of manifest.files) if (hash(await readFile(new URL('../third_party/codex/' + item.local, import.meta.url))) !== item.sha256) throw Error('Upstream source changed: ' + item.path);
const current = JSON.parse(await readFile(new URL('../third_party/codex-current/SOURCE.json', import.meta.url), 'utf8'));
for (const item of current.files) if (hash(await readFile(new URL('../third_party/codex-current/' + item.local, import.meta.url))) !== item.sha256) throw Error('Current Codex source changed: ' + item.path);
let extra = '';
try {
  const companion = await import('./verify-companion.mjs');
  extra = await companion.verify();
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
console.log(`Verified ${manifest.files.length} original and ${current.files.length} current Codex snapshots${extra}`);
