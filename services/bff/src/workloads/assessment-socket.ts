import { createServer } from 'node:http';
import { chmod, chown, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  assessmentRequestListener,
  assessmentDeadline,
  type AssessmentEndpointOptions,
} from './assessment-http.js';

/** Private co-located controller transport, never a TCP listener or public route.
 * The directory is dedicated, empty, owned by this process and initially 0700.
 * The trusted scheduler is provisioned in socketGroup only; no other process may
 * join that group. OS directory/socket permissions authenticate that role. No
 * task proof, SVID, private input or backend credential crosses this socket. */
export async function startAssessmentControllerSocket(
  options: {
    directory: string;
    socketGroup: number;
  } & AssessmentEndpointOptions,
) {
  const deadline = assessmentDeadline(options.deadlineMs);
  const group = z.number().int().min(0).max(2147483647).parse(options.socketGroup);
  if (!process.getuid || !process.getgid) throw new Error('Private controller unavailable');
  const directory = resolve(options.directory),
    uid = process.getuid();
  if (options.directory !== directory || (await realpath(directory)) !== directory)
    throw new Error('Private controller unavailable');
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o7777) !== 0o700 ||
    (await readdir(directory)).length
  )
    throw new Error('Private controller unavailable');
  // A writable ancestor must not allow a different principal to replace the
  // protected directory. Root-owned sticky temporary directories are supported.
  for (let parent = dirname(directory); ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      ![0, uid].includes(stat.uid) ||
      ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
    )
      throw new Error('Private controller unavailable');
    if (parent === dirname(parent)) break;
  }
  const socketPath = join(directory, 'controller.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Private controller unavailable');
  const server = createServer(
    { maxHeaderSize: 4096 },
    assessmentRequestListener(options, async () => Number.MAX_SAFE_INTEGER),
  );
  server.maxConnections = 8;
  server.maxHeadersCount = 12;
  server.requestTimeout = deadline;
  server.headersTimeout = deadline;
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
    // Parent stays 0700 until the socket permissions and group are finalized,
    // so there is no initially world-readable connection window.
    await chown(socketPath, uid, group);
    await chmod(socketPath, 0o660);
    await chown(directory, uid, group);
    await chmod(directory, 0o710);
  } catch {
    server.close();
    throw new Error('Private controller unavailable');
  }
  return {
    socketPath,
    async close() {
      await chmod(directory, 0o700);
      await new Promise<void>((done, fail) =>
        server.close((error) =>
          error ? fail(new Error('Private controller close failed')) : done(),
        ),
      );
    },
  };
}
