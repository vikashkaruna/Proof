import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, chown, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ownedExecutionRequest } from '../services/owned-execution-broker.js';
import { ownedExecutionValue, type OwnedExecutionValue } from './owned-execution-channel.js';
const pointer = ownedExecutionRequest;
/** Only the reviewed execution runtime belongs to this socket group. The worker must
 * still prove its independent SVID to the broker before any retained claim. */
export async function prepareOwnedExecutionSocketDirectory(
  directory: string,
  uid: number,
  group: number,
) {
  const dir = resolve(directory);
  if (dir !== directory || (await realpath(dir)) !== dir)
    throw new Error('Owned execution controller refused');
  const info = await lstat(dir),
    mode = info.mode & 0o7777;
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    !(mode === 0o700 || (mode === 0o750 && info.gid === group))
  )
    throw new Error('Owned execution controller refused');
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    const st = await lstat(parent);
    if (
      !st.isDirectory() ||
      ![0, uid].includes(st.uid) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && st.mode & 0o1000))
    )
      throw new Error('Owned execution controller refused');
    if (parent === dirname(parent)) break;
  }
  const socketPath = join(dir, 'owned-execution.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Owned execution controller refused');
  const entries = await readdir(dir);
  if (entries.length) {
    if (entries.length !== 1 || entries[0] !== 'owned-execution.sock')
      throw new Error('Owned execution controller refused');
    const before = await lstat(socketPath);
    if (
      !before.isSocket() ||
      before.uid !== uid ||
      before.gid !== group ||
      (before.mode & 0o7777) !== 0o660
    )
      throw new Error('Owned execution controller refused');
    await new Promise<void>((done, fail) => {
      const probe = createConnection(socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        fail(new Error('Owned execution listener state unconfirmed'));
      }, 500);
      probe.once('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        fail(new Error('Owned execution controller already running'));
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        if (error.code === 'ECONNREFUSED') done();
        else fail(new Error('Owned execution listener state unconfirmed'));
      });
    });
    const after = await lstat(socketPath);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      !after.isSocket() ||
      after.uid !== uid ||
      after.gid !== group
    )
      throw new Error('Owned execution socket changed');
    await unlink(socketPath);
  }
  return socketPath;
}
export async function startOwnedExecutionSocket(options: {
  directory: string;
  socketGroup: number;
  run: (input: unknown, signal: AbortSignal) => Promise<OwnedExecutionValue>;
}) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Owned execution controller refused');
  const group = z.literal(20113).parse(options.socketGroup),
    dir = options.directory;
  const socketPath = await prepareOwnedExecutionSocketDirectory(dir, uid, group);
  let active = false;
  const server = createServer({ maxHeaderSize: 4096 }, async (req, res) => {
    const send = (status: number, value: unknown) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          connection: 'close',
        });
        res.end(JSON.stringify(value));
      }
    };
    if (active) {
      send(503, { error: 'owned_execution_unconfirmed' });
      return;
    }
    active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      send(503, { error: 'owned_execution_unconfirmed' });
      req.destroy();
    }, 50000);
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/owned-execution/run' ||
        req.headers['content-type'] !== 'application/json' ||
        req.headers['content-encoding']
      )
        throw new Error();
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes = Buffer.concat([bytes, Buffer.from(chunk as Uint8Array)]);
        if (bytes.length > 16384 || abort.signal.aborted) throw new Error();
      }
      const input = pointer.parse(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      );
      bytes.fill(0);
      const outcome = ownedExecutionValue.parse(await options.run(input, abort.signal));
      if (abort.signal.aborted) throw new Error();
      send(200, { data: outcome });
    } catch {
      send(503, { error: 'owned_execution_unconfirmed' });
    } finally {
      clearTimeout(timer);
      active = false;
    }
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 12;
  server.requestTimeout = 50000;
  server.headersTimeout = 50000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_, socket) => socket.destroy());
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(socketPath, done);
    });
    await chown(dir, uid, group);
    await chown(socketPath, uid, group);
    await chmod(socketPath, 0o660);
    await chmod(dir, 0o750);
  } catch {
    server.close();
    throw new Error('Owned execution controller refused');
  }
  return {
    socketPath,
    close: () =>
      new Promise<void>((done, fail) =>
        server.close((error) =>
          error ? fail(new Error('Owned execution controller close failed')) : done(),
        ),
      ),
  };
}
