import { open, mkdir, unlink, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
// Anchor every path component to an open directory descriptor. On Linux this
// prevents a concurrent symlink replacement from redirecting an operation.
export class SafeFs {
  constructor(policy) { this.policy = policy; }
  async parent(input, { owner = 'root', write = false, create = false } = {}, fn) {
    const target = await this.policy.path(input, { owner, write });
    if (target === this.policy.root) throw Error('Expected a file below the workspace root');
    if (process.platform !== 'linux') throw Error('Tracked file operations require Linux /proc descriptor paths');
    const anchor = this.policy.hasFullAccess(owner) ? path.parse(target).root : this.policy.root;
    const segments = path.relative(anchor, target).split(path.sep);
    let directory = await open(anchor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const segment of segments.slice(0, -1)) {
        const next = `/proc/self/fd/${directory.fd}/${segment}`;
        if (create) await mkdir(next).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const child = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close(); directory = child;
      }
      return await fn(`/proc/self/fd/${directory.fd}/${segments.at(-1)}`);
    } finally { await directory.close(); }
  }
  async openRead(input, owner) {
    return this.parent(input, { owner }, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(); if (!info.isFile()) throw Error('Only regular files can be read');
        return handle;
      } catch (error) { await handle.close(); throw error; }
    });
  }
  async list(input, owner, options) {
    const directory = await this.policy.path(input, { owner });
    return this.parent(path.join(directory, '.pi-codex-directory-anchor'), { owner }, target => readdir(path.dirname(target), options));
  }
  async info(input, owner) {
    const target = await this.policy.path(input, { owner });
    if (target === this.policy.root || target === path.parse(target).root) {
      const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { return await handle.stat(); } finally { await handle.close(); }
    }
    return this.parent(target, { owner }, anchored => lstat(anchored));
  }
  async read(input, owner, maxBytes = 32 * 1024 * 1024) {
    const handle = await this.openRead(input, owner);
    try {
      const info = await handle.stat(); if (info.size > maxBytes) throw Error(`File exceeds ${maxBytes} bytes`);
      return { data: await handle.readFile(), mode: info.mode & 0o777 };
    } finally { await handle.close(); }
  }
  async header(input, owner) {
    const handle = await this.openRead(input, owner);
    try { const buffer = Buffer.alloc(16); const { bytesRead } = await handle.read(buffer, 0, 16, 0); return buffer.subarray(0, bytesRead); }
    finally { await handle.close(); }
  }
  async *chunks(input, owner, signal) {
    const handle = await this.openRead(input, owner);
    try { const info = await handle.stat(); if (!info.size) return; yield* handle.createReadStream({ signal, autoClose: false, end: info.size - 1 }); }
    finally { await handle.close(); }
  }
  async write(input, data, owner, { exclusive = false, mode = 0o644 } = {}) {
    return this.parent(input, { owner, write: true, create: true }, async target => {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (exclusive ? constants.O_EXCL : 0), mode);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1) throw Error('Only regular files without hardlinks can be changed');
        await handle.truncate(0); await handle.writeFile(data);
      } finally { await handle.close(); }
    });
  }
  async remove(input, owner) {
    return this.parent(input, { owner, write: true }, async target => {
      const info = await lstat(target); if (!info.isFile() || info.nlink > 1) throw Error('Only regular files without hardlinks can be removed');
      await unlink(target);
    });
  }
  async mode(input, mode, owner) {
    return this.parent(input, { owner, write: true }, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { await handle.chmod(mode); } finally { await handle.close(); }
    });
  }
}
