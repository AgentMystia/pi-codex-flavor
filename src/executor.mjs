import { spawn } from 'node:child_process';
import { access, realpath, mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tmpdir, constants as osConstants } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { deferred, checkAbort, whenInput } from './util.mjs';
import { HeadTailBuffer } from './exec-output.mjs';
import { socketFilter } from './seccomp.mjs';
// Codex caps an empty write_stdin poll at its background terminal timeout, 300 s by default.
export const MAX_POLL_MS = 300000;
const clampWait = ms => Math.max(0, Math.min(ms ?? 1000, MAX_POLL_MS));
async function executable(name) {
  const candidates = name.includes('/') ? [name] : (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => path.join(dir, name));
  for (const candidate of candidates) if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  throw Error(`Executable unavailable: ${name}`);
}
export class Executor {
  constructor({ policy, config, state }) { Object.assign(this, { policy, config, state }); this.jobs = new Map(); this.closed = false; this.pendingLaunches = 0; }
  async command(argv, { owner = 'root', cwd = this.policy.root, readOnly = false, escalated = false } = {}) {
    cwd = await this.policy.path(cwd, { owner });
    if (escalated && (readOnly || this.policy.isReadOnly(owner))) throw Error('Read-only execution cannot leave the sandbox');
    const fullAccess = this.policy.hasFullAccess(owner);
    const permissions = this.policy.permissions;
    const isolated = this.policy.isReadOnly(owner) || (readOnly && !fullAccess) || (!escalated && permissions.sandbox !== 'none');
    const env = { PATH: '/opt/pi-tools:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb' };
    if (!isolated) return { argv, cwd, env: { ...process.env }, isolated: false };
    if (process.platform !== 'linux') throw Error('OS isolation requires Linux and bubblewrap; no unsandboxed fallback');
    const args = ['--die-with-parent', '--new-session', '--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL'];
    const blockNetwork = !permissions.network || readOnly || this.policy.isReadOnly(owner);
    if (blockNetwork) args.push('--unshare-net', '--seccomp', '3');
    for (const dir of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
      if (await access(dir, constants.R_OK).then(() => true, () => false)) args.push('--ro-bind', dir, dir);
    }
    args.push('--dir', '/opt', '--dir', '/opt/pi-tools');
    for (const name of ['rg', 'git']) {
      const binary = await executable(name).catch(() => undefined);
      if (binary) args.push('--ro-bind', binary, `/opt/pi-tools/${name}`);
    }
    const program = await executable(argv[0]);
    if (!['/usr/', '/bin/', '/sbin/', '/lib/'].some(prefix => program.startsWith(prefix)) && !program.startsWith(this.policy.root + '/')) {
      args.push('--ro-bind', program, '/opt/pi-tools/program'); argv = ['/opt/pi-tools/program', ...argv.slice(1)];
    } else argv = [program, ...argv.slice(1)];
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/home', '--dir', '/home/pi');
    args.push(readOnly || this.policy.isReadOnly(owner) ? '--ro-bind' : '--bind', this.policy.root, this.policy.root);
    const gitPath = this.policy.root + '/.git';
    if (await access(gitPath).then(() => true, () => false)) args.push('--ro-bind', gitPath, gitPath);
    args.push('--clearenv', '--setenv', 'PATH', env.PATH, '--setenv', 'LANG', env.LANG, '--setenv', 'HOME', '/home/pi', '--setenv', 'TMPDIR', '/tmp', '--chdir', cwd, '--', ...argv);
    return { argv: [this.config.sandboxCommand, ...args], cwd, env, isolated: true, filter: blockNetwork ? socketFilter() : undefined };
  }
  async launch(argv, options = {}) {
    this.pendingLaunches++;
    try { return await this.launchProcess(argv, options); }
    finally { this.pendingLaunches--; }
  }
  async launchProcess(argv, options = {}) {
    if (this.closed) throw Error('Executor is closed');
    checkAbort(options.signal);
    if (this.jobs.size >= this.config.maxJobs) {
      for (const [key, job] of this.jobs) if (job.done && job.consumed) this.jobs.delete(key);
      if (this.jobs.size >= this.config.maxJobs) throw Error('Process table full; consume or cancel existing jobs');
    }
    if (options.escalated && (options.readOnly || this.policy.isReadOnly(options.owner))) throw Error('Read-only execution cannot leave the sandbox');
    const description = options.escalated ? `Run outside OS sandbox for this command only.\nWorking directory: ${options.cwd ?? this.policy.root}\nReason: ${options.justification ?? 'Explicit unrestricted execution requested'}\nCommand: ${options.description ?? argv.join(' ')}` : options.description ?? argv.join(' ');
    await this.policy.authorize(description, { ...options, process: true, requireApproval: options.escalated || options.requireApproval,
      approval: { kind: 'exec', command: options.command ?? argv.join(' '), cwd: options.cwd ?? this.policy.root, escalated: !!options.escalated } });
    const command = await this.command(argv, options);
    checkAbort(options.signal);
    let filterDir, filterFile;
    if (command.filter) {
      filterDir = await mkdtemp(path.join(tmpdir(), 'pi-codex-seccomp-'));
      const filterPath = path.join(filterDir, 'filter.bpf'); await writeFile(filterPath, command.filter, { mode: 0o600 }); filterFile = await open(filterPath, 'r');
    }
    let processId;
    do { processId = randomInt(1000, 100000); } while (this.jobs.has(processId));
    const job = { id: processId, owner: options.owner ?? 'root', argv, isolated: command.isolated, buffer: new HeadTailBuffer(this.config.outputBytes), done: false, consumed: false, ...deferred() };
    let child;
    try { child = spawn(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe', ...(filterFile ? [filterFile.fd] : [])], detached: true }); }
    catch (error) { await filterFile?.close(); if (filterDir) await rm(filterDir, { recursive: true, force: true }); throw error; }
    job.child = child; this.jobs.set(job.id, job);
    child.stdin.on('error', () => {});
    const append = data => {
      if (options.onData) options.onData(data);
      job.buffer.push(data);
      if (!options.onUpdate) return;
      const output = job.buffer.text();
      options.onUpdate({ content: [{ type: 'text', text: output }], details: { execution: true, output, process_id: job.id, running: true } });
    };
    child.stdout.on('data', append); child.stderr.on('data', options.onStderr ?? append);
    child.on('error', error => { job.error = error.message; });
    let timeout;
    const abort = () => { job.cancelled = true; this.kill(job); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.timeoutMs) timeout = setTimeout(() => { job.timedOut = true; abort(); }, options.timeoutMs);
    child.once('close', (exitCode, signal) => {
      job.done = true; job.exitCode = exitCode; job.signal = signal;
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      this.kill(job); job.resolve(job);
    });
    await filterFile?.close(); if (filterDir) await rm(filterDir, { recursive: true, force: true });
    return job;
  }
  kill(job) {
    if (!job.child.pid) return;
    try { process.kill(-job.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') job.cleanupError = error.message; }
  }
  async exec(params, owner = 'root', signal, onUpdate) {
    const started = performance.now();
    const job = await this.launch([this.config.shell, '--noprofile', '--norc', '-c', params.cmd], {
      owner, cwd: params.workdir, signal, onUpdate, requireApproval: params.require_approval,
      escalated: params.sandbox_permissions === 'require_escalated', justification: params.justification,
      description: params.cmd, command: params.cmd, timeoutMs: params.timeout_ms ?? 300000,
    });
    return this.poll(job.id, owner, params.yield_time_ms, started);
  }
  get(processId, owner) {
    const job = this.jobs.get(processId);
    if (!job || job.owner !== owner) throw Error('Unknown process or different process owner'); return job;
  }
  async poll(processId, owner = 'root', waitMs, started = performance.now(), hasInput) {
    const job = this.get(processId, owner);
    let timer;
    const input = whenInput(hasInput);
    if (!job.done) await Promise.race([job.promise, input.promise, new Promise(resolve => { timer = setTimeout(resolve, clampWait(waitMs)); })]);
    clearTimeout(timer); input.stop();
    const output = job.buffer.text();
    const response = { chunk_id: randomBytes(3).toString('hex'), wall_time_seconds: (performance.now() - started) / 1000,
      original_token_count: Math.ceil(job.buffer.totalBytes / 4), process_id: job.id, running: !job.done, output, exit_code: job.exitCode, signal: job.signal, cancelled: job.cancelled ?? false, timed_out: job.timedOut ?? false, error: job.error, dropped_bytes: job.buffer.omittedBytes, isolated: job.isolated };
    job.buffer.clear(); job.consumed = job.done;
    return response;
  }
  async write(params, owner, hasInput) {
    const started = performance.now();
    const job = this.get(params.session_id ?? params.process_id, owner);
    if (params.cancel) { job.cancelled = true; this.kill(job); }
    if (params.chars && !job.done) await new Promise((resolve, reject) => job.child.stdin.write(params.chars, error => error ? reject(error) : resolve()));
    if (params.eof) job.child.stdin.end();
    return this.poll(job.id, owner, params.yield_time_ms, started, hasInput);
  }
  // Pi's BashOperations contract for a command the user typed: output streams to Pi, Pi's own
  // abort signal cancels it, and like Pi's local shell there is no time limit.
  async stream(command, { owner = 'root', cwd, signal, onData } = {}) {
    const job = await this.launch([this.config.shell, '--noprofile', '--norc', '-c', command], { owner, cwd, signal, onData, description: command, command });
    job.child.stdin.end(); await job.promise; job.consumed = true;
    if (job.error) throw Error(job.error);
    return { exitCode: job.exitCode ?? (job.signal ? 128 + (osConstants.signals[job.signal] ?? 0) : null) };
  }
  async capture(argv, options = {}) {
    const job = await this.launch(argv, { ...options, timeoutMs: options.timeoutMs ?? 30000 });
    job.child.stdin.end(); await job.promise;
    const response = await this.poll(job.id, options.owner ?? 'root', 0);
    if (response.error) throw Error(response.error);
    return response;
  }
  async cancelOwner(owner) {
    const jobs = [...this.jobs.values()].filter(job => job.owner === owner && !job.done);
    for (const job of jobs) { job.cancelled = true; this.kill(job); }
    await Promise.all(jobs.map(job => job.promise));
  }
  async close() { this.closed = true; const owners = new Set([...this.jobs.values()].map(j => j.owner)); await Promise.all([...owners].map(owner => this.cancelOwner(owner))); }
}
