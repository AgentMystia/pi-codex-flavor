import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, link, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, pause } from './helpers.mjs';
import { updateContent, parsePatch } from '../src/patch.mjs';
const patch = body => `*** Begin Patch\n${body}\n*** End Patch`;
test('add, exact update, move, delete return tracked diffs and selective restoration', async t => {
  const f = await fixture(t);
  let response = await f.runtime.files.apply(patch('*** Add File: 中文.txt\n+one\n+two'));
  assert.equal(response.status, 'applied'); assert.match(response.diff, /\+one/);
  response = await f.runtime.files.apply(patch('*** Update File: 中文.txt\n*** Move to: renamed.txt\n@@\n one\n-two\n+three'));
  assert.equal(await readFile(path.join(f.root, 'renamed.txt'), 'utf8'), 'one\nthree\n');
  await f.runtime.files.restore(response.change_id, ['中文.txt', 'renamed.txt']);
  assert.equal(await readFile(path.join(f.root, '中文.txt'), 'utf8'), 'one\ntwo\n');
  await assert.rejects(access(path.join(f.root, 'renamed.txt')));
  response = await f.runtime.files.apply(patch('*** Delete File: 中文.txt'));
  assert.equal(response.status, 'applied'); await f.runtime.files.restore(response.change_id, ['中文.txt']);
});
test('multi-file context failure reports completed changes and partial diff', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a'), 'before\n'); await writeFile(path.join(f.root, 'b'), 'other\n');
  const response = await f.runtime.files.apply(patch('*** Update File: a\n@@\n-before\n+after\n*** Update File: b\n@@\n-missing\n+replacement'));
  assert.equal(response.status, 'partial_failure'); assert.equal(response.completed.length, 1); assert.match(response.diff, /\+after/);
  assert.equal(await readFile(path.join(f.root, 'b'), 'utf8'), 'other\n');
});
test('path escapes, symlinks, hardlinks and Git metadata writes are blocked before edits', async t => {
  const f = await fixture(t); const other = await fixture(t); await writeFile(path.join(other.root, 'secret'), 'secret');
  await symlink(other.root, path.join(f.root, 'escape')); await link(path.join(other.root, 'secret'), path.join(f.root, 'hard'));
  for (const target of ['../escaped', 'escape/secret', 'hard', '.git/config']) await assert.rejects(f.call('write', { path: target, content: 'bad' }), /outside|link|Git/);
  await assert.rejects(f.call('read', { path: 'escape/secret' }), /outside/);
  await writeFile(path.join(f.root, 'real.txt'), 'inside\n'); await symlink('real.txt', path.join(f.root, 'alias.txt'));
  assert.match((await f.call('read', { path: 'alias.txt' })).content[0].text, /inside/, 'a link that stays inside the workspace reads the real file');
  await assert.rejects(f.call('write', { path: 'alias.txt', content: 'bad' }), /link/);
  const attempted = patch('*** Add File: safe\n+safe\n*** Add File: ../escape\n+bad');
  await assert.rejects(f.runtime.files.apply(attempted), /outside/); await assert.rejects(access(path.join(f.root, 'safe')));
});
test('concurrent mutations are serialized; later user edits conflict with restoration', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a'), '0');
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.call('write', { path: `p${i}`, content: String(i) })));
  const output = await f.call('edit', { path: 'a', edits: [{ oldText: '0', newText: '1' }] });
  assert.ok(output.details.change_id); await writeFile(path.join(f.root, 'a'), 'user');
  await assert.rejects(f.runtime.files.restore(output.details.change_id, ['a']), /Concurrent/);
  assert.equal(await readFile(path.join(f.root, 'a'), 'utf8'), 'user');
});
test('verification binds code state, detects tool edits, shell edits and changes during a check', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a'), '1');
  const first = await f.runtime.files.verify({ kind: 'test', cmd: 'test -f a', scope: ['a'] }, f.runtime.executor, 'root');
  assert.equal(first.status, 'passed'); assert.equal(first.stale, false);
  await f.call('write', { path: 'a', content: '2' }); assert.equal(f.runtime.state.data.verifications[0].stale, true);
  const second = await f.runtime.files.verify({ kind: 'lint', cmd: 'false', scope: ['a'] }, f.runtime.executor, 'root'); assert.equal(second.status, 'failed');
  await writeFile(path.join(f.root, 'a'), 'outside mutation'); await f.runtime.files.verificationStatus(); assert.equal(f.runtime.state.data.verifications[1].stale, true);
  const third = await f.runtime.files.verify({ kind: 'build', cmd: 'echo generated > a', scope: ['a'] }, f.runtime.executor, 'root'); assert.equal(third.status, 'passed'); assert.equal(third.stale, true);
});
test('plan and reviewer permissions reject writes and preserve Pi read/image tools', async t => {
  const f = await fixture(t); await f.runtime.setMode('plan');
  await assert.rejects(f.call('apply_patch', { patch: patch('*** Add File: blocked\n+x') }), /Read-only/);
  await assert.rejects(f.call('write', { path: 'blocked', content: 'x' }), /Read-only/);
  f.runtime.state.data.threads.reviewer = { readOnly: true };
  assert.equal(f.runtime.policy.isReadOnly('reviewer'), true);
});
test('strict context rejects ambiguity and preserves CRLF', () => {
  assert.throws(() => updateContent('same\nsame\n', [{ old: ['same'], replacement: ['next'] }]), /Ambiguous/);
  assert.equal(updateContent('a\r\nb\r\n', [{ old: ['b'], replacement: ['c'] }]), 'a\r\nc\r\n');
  assert.throws(() => parsePatch('bad'), /markers/);
});
test('patch context accepts the common Codex patch variants and an anchor picks the place', () => {
  const source = 'class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 1\n';
  const anchored = parsePatch(patch('*** Update File: a.py\n@@ def g(self):\n-        return 1\n+        return 2'));
  assert.equal(updateContent(source, anchored[0].chunks), source.replace(/return 1\n$/, 'return 2\n'), 'an anchor written without its indentation selects the hunk after it');
  const bare = parsePatch(patch('*** Update File: a.py\n     def f(self): \n-        return 1\n+        return 3\n\n     def g(self):\n'));
  assert.equal(updateContent(source, bare[0].chunks), source.replace('return 1', 'return 3'), 'the first hunk may omit @@, and loosely matched context keeps the file text');
  assert.throws(() => updateContent(source, [{ anchor: '', old: ['        return 1'], replacement: ['        return 2'], eof: false }]), /Ambiguous/);
  assert.throws(() => updateContent(source, [{ anchor: '', old: ['        return 9'], replacement: ['x'], eof: false }]), /does not match current contents near: " {8}return 9"/);
});
test('a patch sent through the shell in a Codex form is applied on the tracked path', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'sub dir'));
  const body = patch('*** Add File: x.txt\n+x');
  let output = await f.call('exec_command', { cmd: `cd 'sub dir' && apply_patch <<'EOF'\n${body}\nEOF\n` });
  assert.match(output.content[0].text, /^Applied as change_[0-9a-f]{12}\nA sub dir\/x\.txt \(\+1 -0\)$/);
  output = await f.call('exec_command', { cmd: `applypatch <<EOF\n${patch('*** Update File: x.txt\n@@\n-x\n+y')}\nEOF`, workdir: 'sub dir' });
  assert.equal(await readFile(path.join(f.root, 'sub dir/x.txt'), 'utf8'), 'y\n');
  assert.equal(f.runtime.state.data.changes.length, 2);
  await assert.rejects(f.call('exec_command', { cmd: `cd .. && apply_patch <<'EOF'\n${patch('*** Add File: out.txt\n+x')}\nEOF` }), /outside/);
  output = await f.call('exec_command', { cmd: `echo hi && apply_patch <<'EOF'\n${body}\nEOF` });
  assert.match(output.content[0].text, /\nhi\n.*apply_patch: command not found/, 'any other command still runs in the shell');
  output = await f.call('apply_patch', { patch: `<<'EOF'\n${patch('*** Add File: wrapped.txt\n+w')}\nEOF` });
  assert.match(output.content[0].text, /A wrapped\.txt/, 'a heredoc wrapper around the patch argument is dropped');
});
test('apply_patch answers with the change id and line counts; restore reads the content store', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.txt'), 'one\ntwo\n');
  const output = await f.call('apply_patch', { patch: patch('*** Update File: a.txt\n@@\n one\n-two\n+2\n+three\n*** Add File: b.txt\n+new') });
  assert.match(output.content[0].text, /^Applied as change_[0-9a-f]{12}\nM a\.txt \(\+2 -1\)\nA b\.txt \(\+1 -0\)$/);
  assert.match(output.details.display, /\+three/, 'the tool card still shows the diff');
  const change = f.runtime.state.data.changes.at(-1);
  assert.deepEqual(Object.keys(change.before[path.join(f.root, 'a.txt')]).sort(), ['hash', 'mode'], 'a change record holds hashes, not file contents');
  assert.equal(JSON.stringify(f.persisted).split('one\\ntwo').length - 1, 1, 'the earlier content is stored once, as text');
  const restored = await f.call('restore_changes', { change_id: output.details.change_id, paths: ['a.txt', 'b.txt'] });
  assert.match(restored.content[0].text, /^Restored as change_[0-9a-f]{12}\nM a\.txt \(\+1 -2\)\nD b\.txt \(\+0 -1\)$/);
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'one\ntwo\n'); await assert.rejects(access(path.join(f.root, 'b.txt')));
  await assert.rejects(f.call('apply_patch', { patch: patch('*** Update File: a.txt\n@@\n-missing\n+x') }), /does not match/);
  // A record written before 0.3.0 carries its content inline.
  const legacy = path.join(f.root, 'legacy.txt'); await writeFile(legacy, 'after');
  const inline = text => ({ data: Buffer.from(text).toString('base64'), hash: createHash('sha256').update(text).digest('hex'), mode: 0o644 });
  f.runtime.state.data.changes.push({ id: 'change_legacy', before: { [legacy]: inline('before') }, after: { [legacy]: inline('after') } });
  await f.runtime.files.restore('change_legacy', ['legacy.txt']); assert.equal(await readFile(legacy, 'utf8'), 'before');
  f.runtime.state.data.changes.push({ id: 'change_evicted', before: { [legacy]: { hash: 'gone', mode: 0o644 } }, after: { [legacy]: inline('before') } });
  await assert.rejects(f.runtime.files.restore('change_evicted', ['legacy.txt']), /no longer kept/);
});
test('verification skips ignored build output, records links without following them, and reports compactly', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.gitignore'), 'dist/\n*.log\n'); await writeFile(path.join(f.root, 'a'), '1'); await symlink('a', path.join(f.root, 'link'));
  const output = await f.call('run_verification', { kind: 'build', cmd: 'mkdir -p dist && echo out > dist/bundle.js && echo noise > run.log && echo built' });
  assert.match(output.content[0].text, /^verification_[0-9a-f]{12} build passed \(exit 0\)\nbuilt\n$/);
  assert.equal(output.details.stale, false, 'ignored artifacts written by the check do not make its result stale');
  assert.equal('output' in f.runtime.state.data.verifications[0], false, 'command output is not kept in the durable state');
  await writeFile(path.join(f.root, 'a'), '2');
  assert.match((await f.call('verification_status')).content[0].text, /^verification_[0-9a-f]{12} build passed \(exit 0\), stale: mkdir -p dist/);
});
test('grep and find name files relative to the workspace and cap the whole result', async t => {
  const f = await fixture(t);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(f.root, `${name}.txt`), Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n') + '\n');
  const found = (await f.call('grep', { pattern: 'needle', limit: 5 })).content[0].text.split('\n');
  assert.equal(found.length, 6); for (const line of found.slice(0, 5)) assert.match(line, /^[abc]\.txt:\d+:needle \d$/);
  assert.match(found[5], /^\[\d+\+ more matching lines not shown/);
  assert.equal((await f.call('find', { pattern: '*.txt' })).content[0].text, 'a.txt\nb.txt\nc.txt');
  assert.equal((await f.call('grep', { pattern: 'absent' })).content[0].text, 'No matches found');
  await writeFile(path.join(f.root, 'long.md'), Array.from({ length: 4000 }, (_, i) => `line ${i + 1} of a long file`).join('\n'));
  const page = (await f.call('read', { path: 'long.md' })).content[0].text;
  const next = Number(page.match(/Use offset=(\d+) to continue\.\]$/)?.[1]);
  assert.ok(page.includes(`line ${next - 1} of a long file\n`) && !page.includes(`line ${next} of`), 'a cut read ends on a whole line and names the next one');
});
