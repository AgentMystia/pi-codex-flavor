import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const os = await readFile('/etc/os-release', 'utf8');
// Arch-family physical hosts qualify: plain Arch plus derivatives that carry
// ID_LIKE=arch. Containers are still rejected below.
if (!/^ID=arch$/m.test(os) && !/^ID_LIKE=.*\barch\b/m.test(os)) throw Error('Physical Arch-family Linux is the required acceptance target');
const container = spawnSync('systemd-detect-virt', ['--container', '--quiet']);
if (container.status === 0) throw Error('Container results do not qualify as physical Arch acceptance');
const outcome = spawnSync(process.execPath, ['--test', 'test/executor.test.mjs', 'test/lsp.test.mjs', 'test/threads.test.mjs'], {
  stdio: 'inherit', cwd: new URL('..', import.meta.url), env: { ...process.env, PI_CODEX_REQUIRE_SANDBOX: '1', PI_CODEX_TEST_BWRAP: '/usr/bin/bwrap' },
});
process.exitCode = outcome.status ?? 1;
