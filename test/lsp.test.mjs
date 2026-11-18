import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonRpc } from '../src/lsp.mjs';
import { fixture } from './helpers.mjs';
test('LSP is absent when disabled, performs no startup and declares no tools', async t => {
  const f = await fixture(t); assert.equal(f.runtime.lsp, undefined); assert.equal(f.runtime.executor.jobs.size, 0);
  assert.equal(f.runtime.tools().some(tool => tool.name === 'lsp'), false);
});
test('JSON-RPC handles fragmented UTF-8, bounded frames, request correlation and server command rejection', async () => {
  const writes = []; const rpc = new JsonRpc(data => writes.push(data));
  const pending = rpc.request('textDocument/hover', {});
  const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '中文说明' }));
  const wire = Buffer.concat([Buffer.from(`Content-Length: ${message.length}\r\n\r\n`), message]);
  for (const byte of wire) rpc.feed(Buffer.from([byte]));
  assert.equal(await pending, '中文说明');
  const command = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'workspace/applyEdit', params: {} }));
  rpc.feed(Buffer.concat([Buffer.from(`Content-Length: ${command.length}\r\n\r\n`), command]));
  assert.match(writes.at(-1).toString(), /disabled/); assert.throws(() => rpc.feed(Buffer.from('Content-Length: 2000000\r\n\r\n')), /Invalid/); rpc.close();
});
test('code actions preview edits, reject stale contents, then use the shared tracked queue', async t => {
  const f = await fixture(t, { config: { lsp: [{ name: 'configured', command: ['existing-language-server', '--stdio'], extensions: ['.ts'] }] } });
  const target = path.join(f.root, 'app.ts'); await writeFile(target, 'const value = 1;\n');
  const changes = { changes: { [pathToFileURL(target).href]: [{ range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } }, newText: '2' }] } };
  const preview = await f.runtime.lsp.preview(changes, 'root'); assert.equal(await readFile(target, 'utf8'), 'const value = 1;\n');
  await writeFile(target, 'user change'); await assert.rejects(f.runtime.lsp.apply(preview.preview_id, 'root'), /Concurrent/);
  await writeFile(target, 'const value = 1;\n'); const next = await f.runtime.lsp.preview(changes, 'root');
  const output = await f.runtime.lsp.apply(next.preview_id, 'root'); assert.ok(output.change_id); assert.match(output.diff, /\+const value = 2/);
  assert.equal(f.runtime.executor.jobs.size, 0);
});
test('language server startup requires explicit approval before process execution', async t => {
  let asked = 0;
  const f = await fixture(t, { config: { lsp: [{ name: 'configured', command: ['node', '-e', 'process.exit(42)'], extensions: ['.ts'] }] }, ui: { available: true, select: async () => { asked++; return undefined; } } });
  await assert.rejects(f.runtime.lsp.server('configured', 'root'), /denied/); assert.equal(asked, 1); assert.equal(f.runtime.executor.jobs.size, 0);
  await assert.rejects(f.runtime.lsp.server('not-configured', 'root'), /not configured/);
});
