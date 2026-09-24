import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AssessmentController } from './assessment-controller.js';
import {
  type AssessmentScheduling,
  schedulingTicket,
  schedulingAcknowledgement,
  schedulingReceipt,
} from './assessment-scheduling.js';

export interface AssessmentEndpointOptions {
  controller: Pick<AssessmentController, 'run' | 'reconcile'>;
  scheduling?: Pick<AssessmentScheduling, 'reserve' | 'acknowledge'>;
  deadlineMs?: number;
}
export function assessmentDeadline(value?: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(80000)
    .parse(value ?? 80000);
}
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
/** Shared bounded protocol. Authentication is mandatory and runs before body
 * collection or backend work. One listener owns one operation slot until the
 * underlying operation actually settles, even after deadline/disconnection. */
export function assessmentRequestListener(
  options: AssessmentEndpointOptions,
  authenticate: (request: IncomingMessage) => Promise<number>,
) {
  const deadline = assessmentDeadline(options.deadlineMs);
  let active = false;
  return async (request: IncomingMessage, response: ServerResponse) => {
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
    let identityTimer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.on('close', disconnected);
    try {
      const expiresAt = await authenticate(request);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || abort.signal.aborted)
        throw new Error('Scheduler identity refused');
      if (expiresAt - Date.now() <= deadline)
        identityTimer = setTimeout(
          () => {
            abort.abort();
            send(response, 503, { error: 'assessment_unconfirmed' });
            request.destroy();
          },
          Math.max(1, expiresAt - Date.now()),
        );
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
      if (abort.signal.aborted || expiresAt <= Date.now()) throw new Error('Private request ended');
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
      clearTimeout(identityTimer);
      response.off('close', disconnected);
      // Hold the slot until controller work really settles, even after the
      // caller disconnects. A timeout must not enable an overlapping launch.
      active = false;
    }
  };
}
