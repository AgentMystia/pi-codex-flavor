import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, pause } from './helpers.mjs';
const bwrap = process.env.PI_CODEX_TEST_BWRAP;
const probe = bwrap ? spawnSync(bwrap, ['--unshare-user', '--disable-userns', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], { encoding: 'utf8' }) : null;
const sandboxSkip = !bwrap ? 'Set PI_CODEX_TEST_BWRAP to run physical Linux isolation checks' : probe.status !== 0 ? `Host cannot create the required sandbox: ${probe.stderr.trim()}` : false;
if (process.env.PI_CODEX_REQUIRE_SANDBOX === '1' && sandboxSkip) throw Error(sandboxSkip);
test('background processes support incremental output, stdin, EOF and ownership', async t => {
  const f = await fixture(t);
  const first = await f.runtime.executor.exec({ cmd: 'echo first; read line; echo "second:$line"', yield_time_ms: 10 }, 'root');
  assert.equal(first.running, true); assert.match(first.output, /first/);
  await assert.rejects(f.runtime.executor.write({ process_id: first.process_id, chars: 'bad\n' }, 'child'), /owner/);
  const next = await f.runtime.executor.write({ process_id: first.process_id, chars: '你好\n', eof: true, yield_time_ms: 1000 }, 'root');
  assert.equal(next.exit_code, 0); assert.match(next.output, /second:你好/); assert.doesNotMatch(next.output, /first/);
});
test('process cancellation kills descendants and bounds long output', async t => {
  const f = await fixture(t, { config: { outputBytes: 1024 } });
  const response = await f.runtime.executor.exec({ cmd: '(sleep 0.15; echo leaked > leaked) & wait', yield_time_ms: 5 }, 'root');
  const cancelled = await f.runtime.executor.write({ process_id: response.process_id, cancel: true, yield_time_ms: 1000 }, 'root');
  assert.equal(cancelled.cancelled, true); await pause(180); await assert.rejects(access(path.join(f.root, 'leaked')));
  const long = await f.runtime.executor.capture(['node', '-e', 'process.stdout.write("x".repeat(100000))'], { owner: 'root' });
  assert.ok(long.output.length < 1500); assert.ok(long.dropped_bytes > 0);
});
test('missing sandbox backend never falls back to host execution', async t => {
  const f = await fixture(t, { config: { sandbox: 'workspace-write', sandboxCommand: '/no/such/bwrap' } });
  const response = await f.runtime.executor.exec({ cmd: 'touch should-not-exist', yield_time_ms: 1000 });
  assert.match(response.error, /ENOENT/); await assert.rejects(access(path.join(f.root, 'should-not-exist')));
});
test('escalation is explicit, command-scoped and unavailable in plan mode or never approval', async t => {
  let confirmations = 0;
  const f = await fixture(t, { config: { sandbox: 'workspace-write', sandboxCommand: '/missing/backend' }, ui: { available: true, select: async (title, options) => { assert.match(title, /outside OS sandbox/); confirmations++; return options[0]; } } });
  const response = await f.runtime.executor.exec({ cmd: 'echo explicitly-approved', sandbox_permissions: 'require_escalated', justification: 'Authorized host operation', yield_time_ms: 1000 });
  assert.equal(response.exit_code, 0); assert.equal(response.isolated, false); assert.equal(confirmations, 1);
  const normal = await f.runtime.executor.exec({ cmd: 'true', yield_time_ms: 1000 }); assert.match(normal.error, /ENOENT/);
  await f.runtime.setMode('plan'); await assert.rejects(f.runtime.executor.exec({ cmd: 'true', sandbox_permissions: 'require_escalated' }), /Read-only/);
  const never = await fixture(t, { config: { approval: 'never' } }); await assert.rejects(never.runtime.executor.exec({ cmd: 'true', sandbox_permissions: 'require_escalated' }), /policy is never/);
});
test('real Linux sandbox limits filesystem, network, Unix sockets and inherited environment', { skip: sandboxSkip }, async t => {
  const f = await fixture(t, { config: { sandbox: 'workspace-write', sandboxCommand: bwrap } });
  const outside = await fixture(t); await writeFile(path.join(outside.root, 'secret'), 'private');
  process.env.PI_CODEX_TEST_SECRET = 'must-not-leak'; t.after(() => { delete process.env.PI_CODEX_TEST_SECRET; });
  const out = await f.runtime.executor.capture(['node', '-e', `
    const fs=require('fs');
    if(process.env.PI_CODEX_TEST_SECRET)process.exit(10);
    try{fs.readFileSync(${JSON.stringify(path.join(outside.root, 'secret'))});process.exit(11)}catch(e){if(e.code!=='ENOENT')throw e}
    fs.writeFileSync('inside','ok');
    try{fs.writeFileSync('/etc/pi-codex-test','bad');process.exit(12)}catch(e){}
    const s=require('net').connect({host:'1.1.1.1',port:80});s.on('error',()=>console.log('network-blocked'));setTimeout(()=>process.exit(13),1000).unref();
  `], { owner: 'root' });
  assert.equal(out.exit_code, 0, out.output); assert.match(out.output, /network-blocked/); assert.equal(await readFile(path.join(f.root, 'inside'), 'utf8'), 'ok');
  const socketPath = path.join(f.root, 'host.sock'); const server = createServer();
  await new Promise(resolve => server.listen(socketPath, resolve)); t.after(() => server.close());
  const socket = await f.runtime.executor.capture(['node', '-e', `const s=require('net').connect(${JSON.stringify(socketPath)});s.on('connect',()=>process.exit(20));s.on('error',e=>{console.log(e.code);process.exit(0)})`], { owner: 'root' });
  assert.equal(socket.exit_code, 0, socket.output); assert.match(socket.output, /EPERM|EACCES/);
});
test('real plan mode isolates arbitrary shell writes and reviewer children inherit it', { skip: sandboxSkip }, async t => {
  const f = await fixture(t, { config: { sandbox: 'none', sandboxCommand: bwrap } });
  await writeFile(path.join(f.root, 'file'), 'original'); await f.runtime.setMode('plan');
  const out = await f.runtime.executor.exec({ cmd: 'echo changed > file', yield_time_ms: 1000 });
  assert.notEqual(out.exit_code, 0); assert.equal(out.isolated, true); assert.equal(await readFile(path.join(f.root, 'file'), 'utf8'), 'original');
  f.runtime.state.data.threads.reviewer = { readOnly: true };
  const child = await f.runtime.executor.capture(['node', '-e', 'require("fs").writeFileSync("file","changed")'], { owner: 'reviewer' });
  assert.notEqual(child.exit_code, 0); assert.equal(await readFile(path.join(f.root, 'file'), 'utf8'), 'original');
});
