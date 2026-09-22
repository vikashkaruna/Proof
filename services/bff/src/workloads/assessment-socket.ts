import { createServer, type ServerResponse } from 'node:http';
import { chmod, chown, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AssessmentController } from './assessment-controller.js';
import {
  type AssessmentScheduling,
  schedulingTicket,
  schedulingAcknowledgement,
  schedulingReceipt,
} from './assessment-scheduling.js';

const assignment = z.object({ tenantId: z.uuid(), jobId: z.uuid() }).strict();
const outcome = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('confirmed'),
      runId: z.uuid(),
      receipt: z.string().regex(/^[1-9][0-9]*$/),
      resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
      cleanupConfirmed: z.boolean().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unconfirmed'),
      runId: z.uuid().optional(),
      cleanupConfirmed: z.boolean().nullable(),
    })
    .strict(),
]);
const send = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  response.end(JSON.stringify(value));
};
/** Private co-located controller transport, never a TCP listener or public route.
 * The directory is dedicated, empty, owned by this process and initially 0700.
 * The trusted scheduler is provisioned in socketGroup only; no other process may
 * join that group. OS directory/socket permissions authenticate that role. No
 * task proof, SVID, private input or backend credential crosses this socket. */
export async function startAssessmentControllerSocket(options: {
  directory: string;
  socketGroup: number;
  controller: Pick<AssessmentController, 'run' | 'reconcile'>;
  scheduling?: Pick<AssessmentScheduling, 'reserve' | 'acknowledge'>;
  deadlineMs?: number;
}) {
  const deadline = z
    .number()
    .int()
    .min(1)
    .max(80000)
    .parse(options.deadlineMs ?? 80000);
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
  let active = false;
  const server = createServer({ maxHeaderSize: 4096 }, async (request, response) => {
    if (active) {
      send(response, 503, { error: 'assessment_unconfirmed' });
      return;
    }
    active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      send(response, 503, { error: 'assessment_unconfirmed' });
      request.destroy();
    }, deadline);
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.on('close', disconnected);
    try {
      if (
        request.method !== 'POST' ||
        ![
          '/assessment/run',
          '/assessment/reconcile',
          '/assessment/scheduling/poll',
          '/assessment/scheduling/ack',
        ].includes(request.url ?? '') ||
        request.headers['content-type'] !== 'application/json' ||
        request.headers['content-encoding']
      )
        throw new Error('Private request refused');
      let body = Buffer.alloc(0);
      for await (const chunk of request) {
        body = Buffer.concat([body, Buffer.from(chunk as Uint8Array)]);
        if (
          body.length > (request.url === '/assessment/scheduling/ack' ? 1024 : 512) ||
          abort.signal.aborted
        )
          throw new Error('Private request refused');
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (abort.signal.aborted) throw new Error('Private request ended');
      if (request.url === '/assessment/scheduling/poll') {
        z.object({}).strict().parse(value);
        if (!options.scheduling) throw new Error('Scheduling unavailable');
        const result = z
          .object({ jobs: z.array(schedulingTicket).max(1) })
          .strict()
          .parse(await options.scheduling.reserve());
        if (!abort.signal.aborted) send(response, 200, result);
      } else if (request.url === '/assessment/scheduling/ack') {
        if (!options.scheduling) throw new Error('Scheduling unavailable');
        const acknowledgement = schedulingAcknowledgement.parse(value);
        const result = schedulingReceipt.parse(
          await options.scheduling.acknowledge(acknowledgement),
        );
        if (!abort.signal.aborted) send(response, 200, result);
      } else {
        const job = assignment.parse(value);
        const result = outcome.parse(
          await (request.url === '/assessment/run'
            ? options.controller.run(job.tenantId, job.jobId, abort.signal)
            : options.controller.reconcile(job.tenantId, job.jobId)),
        );
        if (!abort.signal.aborted) send(response, 200, { ...job, ...result });
      }
    } catch {
      send(response, 503, { error: 'assessment_unconfirmed' });
    } finally {
      clearTimeout(timer);
      response.off('close', disconnected);
      // Hold the slot until controller work really settles, even after the
      // caller disconnects. A timeout must not enable an overlapping launch.
      active = false;
    }
  });
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
