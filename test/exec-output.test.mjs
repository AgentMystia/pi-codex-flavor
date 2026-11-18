import test from 'node:test';
import assert from 'node:assert/strict';
import { execResult, HeadTailBuffer, renderCaptured, truncateMiddle, truncateText } from '../src/exec-output.mjs';
import { renderToolResult } from '../src/ui.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { fixture } from './helpers.mjs';

const observation = output => ({ chunk_id: 'abc123', wall_time_seconds: 1.25, output, exit_code: 0, running: false, original_token_count: 10, dropped_bytes: 0 });
const text = result => result.content[0].text;

test('a finished command returns one status line and the raw multiline output', () => {
  // Output fixture from Codex core/src/tools/context_tests.rs under this suite's one-line header.
  const raw = 'token one token two token three token four token five';
  assert.equal(text(execResult(observation(raw), 40000)),
    'Exit code 0 (1.3s)\n' + raw);
  const result = execResult(observation('中文\n"quoted" \\path\n'), 24000);
  assert.equal(text(result), 'Exit code 0 (1.3s)\n中文\n"quoted" \\path\n');
  assert.equal(text(execResult(observation(''), 24000)), 'Exit code 0 (1.3s)', 'no output leaves the status line alone');
  assert.doesNotMatch(text(result), /"output":|"running":|"cancelled":|"isolated":/);
});

test('upstream token truncation fixture and serialization allowance are preserved', () => {
  const result = execResult(observation('token one token two token three token four token five'), 40000, 4);
  assert.equal(text(result), 'Exit code 0 (1.3s)\nWarning: truncated output (original token count: 14)\nTotal output lines: 1\n\ntoken on…10 tokens truncated…ken five');
  const raw = Array.from({ length: 150 }, (_, i) => `${i + 1}\n`).join('');
  const bounded = execResult({ ...observation(raw), original_token_count: 123 }, 200);
  assert.ok(Buffer.byteLength(text(bounded)) <= 240);
  assert.equal((text(bounded).match(/chars truncated/g) ?? []).length, 1);
  assert.match(text(bounded), /Total output lines: 150/);
  assert.match(text(bounded), /\n1\n2\n3\n/); assert.ok(text(bounded).endsWith('149\n150\n'));
});

test('collection preserves head/tail and omitted byte count across chunks and resets', () => {
  const buffer = new HeadTailBuffer(10);
  buffer.push(Buffer.from('HEAD-')); buffer.push(Buffer.from('0123456789')); buffer.push(Buffer.from('-TAIL'));
  assert.equal(buffer.text(), 'HEAD-\n... 10 bytes omitted ...\n-TAIL');
  assert.equal(buffer.totalBytes, 20); assert.equal(buffer.omittedBytes, 10);
  buffer.clear(); buffer.push(Buffer.from('next')); assert.equal(buffer.text(), 'next'); assert.equal(buffer.totalBytes, 4);
});

test('omission metadata survives model truncation exactly once and UTF-8 boundaries stay valid', () => {
  const marker = '... 123456 bytes omitted ...';
  const raw = 'HEAD-' + 'a'.repeat(100) + '\n' + marker + '\nTAIL-' + 'z'.repeat(100);
  const output = text(execResult({ ...observation(raw), original_token_count: 42000, dropped_bytes: 123456 }, 40000, 4));
  assert.match(output, /Warning: truncated output \(original token count: 42000\)/);
  assert.equal(output.split(marker).length - 1, 1);
  for (const unit of ['bytes', 'tokens']) for (let value = 0; value < 25; value++) {
    const result = renderCaptured('中文🙂'.repeat(40), 0, { unit, value });
    assert.ok(!result.includes('\ufffd'));
  }
});

test('running commands expose a resumable session; completed commands hide it', async t => {
  const f = await fixture(t);
  const running = await f.call('exec_command', { cmd: 'echo first; read line; echo "second:$line"', yield_time_ms: 10 });
  const session = Number(text(running).match(/^Running \(\d+\.\ds\), session ID (\d+)\n/)?.[1]);
  assert.ok(session >= 1000 && session < 100000);
  assert.match(text(running), /\nfirst\n$/);
  await assert.rejects(f.runtime.executor.write({ session_id: session, chars: 'not allowed\n' }, 'child'), /owner/);
  const completed = await f.call('write_stdin', { session_id: session, chars: '你好\n', eof: true, yield_time_ms: 1000 });
  assert.match(text(completed), /^Exit code 0 \(\d+\.\ds\)\nsecond:你好\n$/);
  assert.doesNotMatch(text(completed), /session ID|process_|first|cancelled|timed_out/);
});

test('an empty write_stdin poll may wait for minutes but returns as soon as the user sends input', async t => {
  const f = await fixture(t);
  const running = await f.call('exec_command', { cmd: 'sleep 30', yield_time_ms: 250 });
  const session = Number(text(running).match(/session ID (\d+)/)[1]);
  const poll = f.runtime.tools().find(tool => tool.name === 'write_stdin');
  const started = Date.now();
  const steered = await poll.execute('poll', { session_id: session, yield_time_ms: 300000 }, undefined, undefined, { ...f.context, hasPendingMessages: () => true });
  assert.ok(Date.now() - started < 3000, 'pending user input ends the wait');
  assert.match(text(steered), /^Running \(\d+\.\ds\), session ID \d+$/);
  const ended = await poll.execute('stop', { session_id: session, cancel: true }, undefined, undefined, f.context);
  assert.match(text(ended), /Command cancelled/);
});
test('terminal failures remain clear without a JSON wrapper or false success', async t => {
  const f = await fixture(t);
  const failure = await f.call('exec_command', { cmd: 'echo failed >&2; exit 7', yield_time_ms: 1000 });
  assert.match(text(failure), /^Exit code 7 \(\d+\.\ds\)\nfailed\n$/);
  const timed = await f.call('exec_command', { cmd: 'sleep 10', timeout_ms: 15, yield_time_ms: 1000 });
  assert.match(text(timed), /Command timed out/); assert.doesNotMatch(text(timed), /session ID|Exit code 0/);
  const missing = await fixture(t, { config: { sandbox: 'workspace-write', sandboxCommand: '/missing/backend' } });
  await assert.rejects(missing.call('exec_command', { cmd: 'true', yield_time_ms: 1000 }), /exec_command failed:.*ENOENT/);
});

test('terminal tool card shows raw head/tail output, narrow Chinese and terminal status without model headers', () => {
  const output = Array.from({ length: 20 }, (_, i) => `第${i + 1}行中文`).join('\n');
  const result = execResult(observation(output), 24000);
  const theme = { fg: (_color, value) => value };
  const collapsed = renderToolResult(result, { expanded: false, isPartial: false }, theme);
  const expanded = renderToolResult(result, { expanded: true, isPartial: false }, theme);
  const preview = collapsed.render(80).join('\n');
  assert.match(preview, /第1行中文/); assert.match(preview, /第20行中文/); assert.match(preview, /\+12 lines/);
  assert.doesNotMatch(preview, /Exit code|session ID|exit 0/);
  assert.match(expanded.render(80).join('\n'), /第10行中文/);
  for (const width of [1, 12, 24, 80]) for (const component of [collapsed, expanded]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
  const running = execResult({ ...observation(''), running: true, process_id: 12345, exit_code: undefined }, 24000);
  assert.match(renderToolResult(running, { expanded: false, isPartial: false }, theme).render(80).join('\n'), /运行中 · session 12345/);
});
test('truncateMiddle and truncateText bound text on UTF-8 boundaries like the Codex utils', () => {
  const long = `${'中'.repeat(400)}${'ascii'.repeat(200)}`;
  const middle = truncateMiddle(long, 900);
  assert.ok(Buffer.byteLength(middle) > 900 && Buffer.byteLength(middle) < 1100, 'the marker sits outside the retained budget');
  assert.match(middle, /\d+ chars truncated/);
  assert.ok(middle.includes('ascii'), 'the tail is retained');
  assert.equal(truncateMiddle('short', 900), 'short');
  const ascii = 'x'.repeat(2000);
  assert.match(truncateMiddle(ascii, 900), /1100 chars truncated/);
  const headTail = truncateText(`${'a'.repeat(5000)}tail-marker`, { unit: 'bytes', value: 1000 });
  assert.match(headTail, /chars truncated…\n?tail-marker|tail-marker/);
  assert.ok(headTail.startsWith('aaaa'));
});
