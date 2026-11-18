import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'pi-codex-profile-'));
const settings = { packages: [packageDir], cacheWarming: 'off' };
try {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings, null, 2));
  const run = spawnSync(process.execPath, [path.resolve(packageDir, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'), '--help'], { cwd: packageDir, env: { ...process.env, PI_CODING_AGENT_DIR: profile }, encoding: 'utf8' });
  if (run.status !== 0) throw Error(run.stderr);
  if (!run.stdout.includes('--codex-config')) throw Error('Temporary profile did not load extension flags');
  console.log('Temporary CLI profile loaded without credentials or model requests');
} finally { await rm(profile, { recursive: true, force: true }); }
