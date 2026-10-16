import { createServer, type IncomingMessage } from 'node:http';
import { chmod, chown, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseCatalogueJson } from '@axiom/control-library';
import { LocalKeyService } from './local-key-service.js';
import type { LocalKeyCaller } from './local-key-policy.js';

const requestSchema = z
  .object({
    operation: z.enum(['wrap', 'unwrap']),
    context: z.string().max(5500),
    key: z.string().max(100),
    keyRef: z.string().max(500).optional(),
  })
  .strict();
function bytes(value: string) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Refused');
  return decoded;
}
/** No startup importer. The verifier MUST authenticate the actual socket peer's
 * workload/tenant/operation authority, not trust body claims or loopback origin.
 * Missing verifier refuses every request; filesystem group is defense in depth.
 * No master key or provision operation is exposed over this transport. */
export async function startLocalKeySocket(options: {
  directory: string;
  socketGroup: number;
  service: LocalKeyService;
  verifyPeer?: (request: IncomingMessage, deadline: number) => Promise<LocalKeyCaller>;
}) {
  const service = options.service,
    verifyPeer = options.verifyPeer;
  if (!process.getuid) throw new Error('Local key service unavailable');
  const directory = resolve(options.directory),
    uid = process.getuid();
  const group = z.number().int().min(0).max(2147483647).parse(options.socketGroup);
  if (options.directory !== directory || (await realpath(directory)) !== directory)
    throw new Error('Local key service unavailable');
  for (let path = directory; ; path = dirname(path)) {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      ![0, uid].includes(stat.uid) ||
      (path === directory
        ? stat.uid !== uid || (stat.mode & 0o7777) !== 0o700
        : (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
    )
      throw new Error('Local key service unavailable');
    if (path === dirname(path)) break;
  }
  if ((await readdir(directory)).length) throw new Error('Local key service unavailable');
  const socketPath = join(directory, 'keys.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Local key service unavailable');
  let pendingPeers = 0;
  const server = createServer({ maxHeaderSize: 4096 }, (request, response) => {
    const deadline = Date.now() + 5000;
    const timer = setTimeout(() => {
      response.destroy();
      request.destroy();
    }, 5000);
    void (async () => {
      let secret: Buffer | undefined;
      try {
        if (request.method !== 'POST' || request.url !== '/dispatch-key' || !verifyPeer)
          throw new Error('Refused');
        if (pendingPeers >= 8) throw new Error('Refused');
        pendingPeers++;
        const verification = Promise.resolve()
          .then(() => verifyPeer!(request, deadline))
          .finally(() => {
            pendingPeers--;
          });
        let peerTimer: ReturnType<typeof setTimeout> | undefined;
        let peer: LocalKeyCaller;
        try {
          peer = await Promise.race([
            verification,
            new Promise<never>((_, reject) => {
              peerTimer = setTimeout(
                () => reject(new Error('Refused')),
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(peerTimer);
        }
        const caller = Object.freeze({ ...peer });
        if (Date.now() >= deadline || request.destroyed) throw new Error('Refused');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const value: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > 8192) throw new Error('Refused');
          chunks.push(value);
        }
        const body = requestSchema.parse(
          parseCatalogueJson(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
            8192,
          ),
        );
        secret = bytes(body.key);
        let result: object;
        if (body.operation === 'wrap') {
          if (body.keyRef !== undefined) throw new Error('Refused');
          const wrapped = await service.wrap(caller, bytes(body.context), secret, deadline);
          result = {
            keyRef: wrapped.keyRef,
            wrappedKey: Buffer.from(wrapped.wrappedKey).toString('base64'),
          };
        } else {
          if (!body.keyRef) throw new Error('Refused');
          const key = await service.unwrap(
            caller,
            bytes(body.context),
            body.keyRef,
            secret,
            deadline,
          );
          try {
            result = { key: Buffer.from(key).toString('base64') };
          } finally {
            key.fill(0);
          }
        }
        if (Date.now() >= deadline || response.destroyed) throw new Error('Refused');
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(result));
      } catch {
        if (!response.destroyed) {
          response.writeHead(403, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          response.end('{"error":"local_key_refused"}');
        }
      } finally {
        secret?.fill(0);
        clearTimeout(timer);
      }
    })();
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 12;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(socketPath, () => {
        server.off('error', fail);
        done();
      });
    });
    await chown(socketPath, uid, group);
    await chmod(socketPath, 0o660);
    await chown(directory, uid, group);
    await chmod(directory, 0o710);
  } catch {
    server.close();
    throw new Error('Local key service unavailable');
  }
  return {
    socketPath,
    async close() {
      await chmod(directory, 0o700);
      await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
    },
  };
}
