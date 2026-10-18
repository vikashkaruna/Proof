import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { chmod, chown, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareDiscoverySocketDirectory } from './discovery-socket.js';
const uid = process.getuid!(),
  gid = process.getgid!();
async function directory() {
  const path = await mkdtemp(join(await realpath('/tmp'), 'axiom-discovery-socket-'));
  await chmod(path, 0o700);
  await chown(path, uid, gid);
  return path;
}
it('accepts staged empty directories and exact graceful-restart permissions', async () => {
  const dir = await directory();
  try {
    expect(await prepareDiscoverySocketDirectory(dir, uid, gid)).toBe(join(dir, 'discovery.sock'));
    await chmod(dir, 0o750);
    expect(await prepareDiscoverySocketDirectory(dir, uid, gid)).toBe(join(dir, 'discovery.sock'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('never removes a live owned listener', async () => {
  const dir = await directory(),
    socket = join(dir, 'discovery.sock');
  const server = createServer((client) => client.destroy());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o660);
  await chmod(dir, 0o750);
  try {
    const before = await lstat(socket);
    await expect(prepareDiscoverySocketDirectory(dir, uid, gid)).rejects.toThrow('already running');
    expect((await lstat(socket)).ino).toBe(before.ino);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
it('removes only a proved stale same-inode owned socket after an abrupt worker exit', async () => {
  const dir = await directory(),
    socket = join(dir, 'discovery.sock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready\\n'))",
      socket,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await once(child.stdout!, 'data');
    await chmod(socket, 0o660);
    await chmod(dir, 0o750);
    child.kill('SIGKILL');
    await once(child, 'close');
    expect((await lstat(socket)).isSocket()).toBe(true);
    expect(await prepareDiscoverySocketDirectory(dir, uid, gid)).toBe(socket);
    await expect(lstat(socket)).rejects.toThrow();
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
it('refuses unknown entries and regular-file substitutions without deleting them', async () => {
  const dir = await directory(),
    socket = join(dir, 'discovery.sock');
  try {
    await writeFile(socket, 'not a socket', { mode: 0o660 });
    await expect(prepareDiscoverySocketDirectory(dir, uid, gid)).rejects.toThrow();
    expect((await lstat(socket)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
