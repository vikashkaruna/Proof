import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, chown, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { controllerFilePath, readControllerFile } from './controller-files.js';
import { discoveryOutcome, type DiscoveryOutcome } from './discovery-channel.js';
const pointer = z.object({ tenantId: z.uuid(), requestId: z.uuid() }).strict();
const config = z
  .object({
    socketPath: controllerFilePath,
    controllerUid: z.literal(20105),
    socketGroup: z.literal(20112),
  })
  .strict();
/** Only the authenticated BFF belongs to this socket group. The worker must
 * still prove its independent SVID to the broker before any retained claim. */
export async function prepareDiscoverySocketDirectory(
  directory: string,
  uid: number,
  group: number,
) {
  const dir = resolve(directory);
  if (dir !== directory || (await realpath(dir)) !== dir)
    throw new Error('Discovery controller refused');
  const info = await lstat(dir),
    mode = info.mode & 0o7777;
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    !(mode === 0o700 || (mode === 0o750 && info.gid === group))
  )
    throw new Error('Discovery controller refused');
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    const st = await lstat(parent);
    if (
      !st.isDirectory() ||
      ![0, uid].includes(st.uid) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && st.mode & 0o1000))
    )
      throw new Error('Discovery controller refused');
    if (parent === dirname(parent)) break;
  }
  const socketPath = join(dir, 'discovery.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Discovery controller refused');
  const entries = await readdir(dir);
  if (entries.length) {
    if (entries.length !== 1 || entries[0] !== 'discovery.sock')
      throw new Error('Discovery controller refused');
    const before = await lstat(socketPath);
    if (
      !before.isSocket() ||
      before.uid !== uid ||
      before.gid !== group ||
      (before.mode & 0o7777) !== 0o660
    )
      throw new Error('Discovery controller refused');
    await new Promise<void>((done, fail) => {
      const probe = createConnection(socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        fail(new Error('Discovery listener state unconfirmed'));
      }, 500);
      probe.once('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        fail(new Error('Discovery controller already running'));
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        if (error.code === 'ECONNREFUSED') done();
        else fail(new Error('Discovery listener state unconfirmed'));
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
      throw new Error('Discovery socket changed');
    await unlink(socketPath);
  }
  return socketPath;
}
export async function startDiscoverySocket(options: {
  directory: string;
  socketGroup: number;
  run: (input: unknown, signal: AbortSignal) => Promise<DiscoveryOutcome>;
}) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Discovery controller refused');
  const group = z.literal(20112).parse(options.socketGroup),
    dir = options.directory;
  const socketPath = await prepareDiscoverySocketDirectory(dir, uid, group);
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
      send(503, { error: 'discovery_unconfirmed' });
      return;
    }
    active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      send(503, { error: 'discovery_unconfirmed' });
      req.destroy();
    }, 50000);
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/discovery/run' ||
        req.headers['content-type'] !== 'application/json' ||
        req.headers['content-encoding']
      )
        throw new Error();
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes = Buffer.concat([bytes, Buffer.from(chunk as Uint8Array)]);
        if (bytes.length > 512 || abort.signal.aborted) throw new Error();
      }
      const input = pointer.parse(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      );
      bytes.fill(0);
      const outcome = discoveryOutcome.parse(await options.run(input, abort.signal));
      if (abort.signal.aborted) throw new Error();
      send(200, { data: outcome });
    } catch {
      send(503, { error: 'discovery_unconfirmed' });
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
    throw new Error('Discovery controller refused');
  }
  return {
    socketPath,
    close: () =>
      new Promise<void>((done, fail) =>
        server.close((error) =>
          error ? fail(new Error('Discovery controller close failed')) : done(),
        ),
      ),
  };
}
export async function verifyDiscoveryControllerSocket(raw: unknown) {
  const c = config.parse(raw);
  if ((await realpath(dirname(c.socketPath))) !== dirname(c.socketPath))
    throw new Error('Discovery controller refused');
  for (let parent = dirname(c.socketPath); ; parent = dirname(parent)) {
    const ancestor = await lstat(parent);
    if (
      !ancestor.isDirectory() ||
      ![0, c.controllerUid].includes(ancestor.uid) ||
      ((ancestor.mode & 0o022) !== 0 && !(ancestor.uid === 0 && ancestor.mode & 0o1000))
    )
      throw new Error('Discovery controller refused');
    if (parent === dirname(parent)) break;
  }
  const st = await lstat(c.socketPath),
    dir = await lstat(dirname(c.socketPath));
  if (
    !st.isSocket() ||
    st.uid !== c.controllerUid ||
    st.gid !== c.socketGroup ||
    (st.mode & 0o7777) !== 0o660 ||
    dir.uid !== c.controllerUid ||
    dir.gid !== c.socketGroup ||
    (dir.mode & 0o7777) !== 0o750
  )
    throw new Error('Discovery controller refused');
}
export function discoverySocketClient(raw: unknown) {
  const c = config.parse(raw);
  return {
    check: () => verifyDiscoveryControllerSocket(c),
    async run(tenantId: string, requestId: string): Promise<DiscoveryOutcome> {
      const input = pointer.parse({ tenantId, requestId });
      await verifyDiscoveryControllerSocket(c);
      return new Promise((done, fail) => {
        const req = request(
          {
            socketPath: c.socketPath,
            path: '/discovery/run',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            agent: false,
          },
          (res) => {
            let bytes = Buffer.alloc(0);
            res.on('data', (chunk: Buffer) => {
              bytes = Buffer.concat([bytes, chunk]);
              if (bytes.length > 2048) req.destroy(new Error('Discovery response refused'));
            });
            res.on('error', fail);
            res.on('aborted', () => fail(new Error('Discovery response refused')));
            res.on('end', () => {
              try {
                if (
                  res.statusCode !== 200 ||
                  res.headers['content-type'] !== 'application/json' ||
                  res.headers['content-encoding']
                )
                  throw new Error();
                done(
                  z
                    .object({ data: discoveryOutcome })
                    .strict()
                    .parse(JSON.parse(bytes.toString('utf8'))).data,
                );
              } catch {
                fail(new Error('Discovery response refused'));
              }
            });
          },
        );
        const timer = setTimeout(
          () => req.destroy(new Error('Discovery controller timed out')),
          51000,
        );
        req.once('close', () => clearTimeout(timer));
        req.on('error', fail);
        req.end(JSON.stringify(input));
      });
    },
  };
}
export async function loadDiscoverySocket(filename: string | undefined) {
  if (!filename) return undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = await readControllerFile(filename);
    return discoverySocketClient(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Discovery client startup refused');
  } finally {
    bytes?.fill(0);
  }
}
