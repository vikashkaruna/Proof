import { createServer, request } from 'node:http';
import { chmod, chown, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ASSESSMENT_REQUEST_MAX_BYTES,
  AssessmentRequestSchema,
  type AssessmentRequest,
} from '@axiom/types';
import {
  type AssessmentRequestProducer,
  AssessmentContextRefused,
  AssessmentQuestionnaireRefused,
} from './assessment-producer.js';
import { DispatchRefused } from './dispatch-payload.js';
import { controllerFilePath, readControllerFile } from './controller-files.js';

const uuid = z.uuid().transform((s) => s.toLowerCase());
const input = z
  .object({ tenantId: uuid, actorId: uuid, request: AssessmentRequestSchema })
  .strict();
const receipt = z
  .object({
    job_id: uuid,
    run_id: uuid,
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
const errorCode = z.enum([
  'assessment_questionnaire_mismatch',
  'assessment_engagement_not_found',
  'assessment_already_recorded',
  'assessment_request_unconfirmed',
]);
const reply = z.union([
  z.object({ data: receipt }).strict(),
  z.object({ error: errorCode }).strict(),
]);
const MAX_BYTES = ASSESSMENT_REQUEST_MAX_BYTES + 1024;
const DEADLINE_MS = 30000;

/** Operator-controlled socket transport. Only the trusted BFF belongs to the
 * socket group: it authenticates the human and checks capabilities before
 * forwarding. This is never a browser endpoint or a TCP listener. The producer
 * independently rechecks the actor, tenant, retained source and custody in SQL. */
export async function startAssessmentProducerSocket(options: {
  directory: string;
  socketGroup: number;
  producer: AssessmentRequestProducer;
  deadlineMs?: number;
}) {
  const uid = process.getuid?.();
  const group = z.number().int().min(0).max(2147483647).parse(options.socketGroup);
  const deadline = z
    .number()
    .int()
    .min(1)
    .max(DEADLINE_MS)
    .parse(options.deadlineMs ?? DEADLINE_MS);
  const directory = resolve(options.directory);
  if (
    uid === undefined ||
    options.directory !== directory ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Private producer unavailable');
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await readdir(directory)).length
  )
    throw new Error('Private producer unavailable');
  for (let parent = dirname(directory); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      ![0, uid].includes(info.uid) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && info.mode & 0o1000))
    )
      throw new Error('Private producer unavailable');
    if (parent === dirname(parent)) break;
  }
  const socketPath = join(directory, 'producer.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Private producer unavailable');
  let active = false;
  const server = createServer({ maxHeaderSize: 4096 }, async (req, res) => {
    const send = (status: number, value: z.infer<typeof reply>) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        connection: 'close',
      });
      res.end(JSON.stringify(value));
    };
    if (active) {
      send(503, { error: 'assessment_request_unconfirmed' });
      return;
    }
    active = true;
    let ended = false;
    const timer = setTimeout(() => {
      ended = true;
      send(503, { error: 'assessment_request_unconfirmed' });
      req.destroy();
    }, deadline);
    res.once('close', () => {
      ended = true;
    });
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/assessment/request' ||
        req.headers['content-type'] !== 'application/json' ||
        req.headers['content-encoding']
      )
        throw new Error();
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes = Buffer.concat([bytes, Buffer.from(chunk as Uint8Array)]);
        if (bytes.length > MAX_BYTES || ended) throw new Error();
      }
      const value = input.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      bytes.fill(0);
      if (ended) throw new Error();
      const result = receipt.parse(
        await options.producer.request(value.tenantId, value.actorId, value.request),
      );
      if (result.job_id !== value.request.operationKey.toLowerCase()) throw new Error();
      if (!ended) send(200, { data: result });
    } catch (error) {
      const code =
        error instanceof AssessmentQuestionnaireRefused
          ? 'assessment_questionnaire_mismatch'
          : error instanceof AssessmentContextRefused
            ? error.code
            : 'assessment_request_unconfirmed';
      if (!ended) send(code === 'assessment_request_unconfirmed' ? 503 : 409, { error: code });
    } finally {
      clearTimeout(timer);
      // No overlapping enqueue even if a disconnected caller times out while
      // the backend is still settling. Recovery uses the same operation key.
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
    await chown(socketPath, uid, group);
    await chmod(socketPath, 0o660);
    await chown(directory, uid, group);
    await chmod(directory, 0o710);
  } catch {
    server.close();
    throw new Error('Private producer unavailable');
  }
  return {
    socketPath,
    async close() {
      await chmod(directory, 0o700);
      await new Promise<void>((done, fail) =>
        server.close((error) =>
          error ? fail(new Error('Private producer close failed')) : done(),
        ),
      );
    },
  };
}

export const assessmentProducerSocketConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    socketPath: controllerFilePath.refine((s) => Buffer.byteLength(s) <= 100),
    producerUid: z.number().int().nonnegative().max(2147483647),
    socketGroup: z.number().int().nonnegative().max(2147483647),
    tenantIds: z
      .array(uuid)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

/** Local same-host socket only. The deployment mount and all ancestors are
 * operator-controlled; file metadata pins the producer and trusted BFF group.
 * The facade grants no controller/unwrap/launch authority. */
export function assessmentProducerSocketClient(configuration: unknown): AssessmentRequestProducer {
  const config = assessmentProducerSocketConfiguration.parse(configuration);
  return Object.freeze({
    configurationForTenant: (tenantId: string) => config.tenantIds.includes(uuid.parse(tenantId)),
    async request(tenantId: string, actorId: string, value: AssessmentRequest) {
      try {
        const data = input.parse({ tenantId, actorId, request: value });
        if (!config.tenantIds.includes(data.tenantId)) throw new Error();
        if ((await realpath(config.socketPath)) !== config.socketPath) throw new Error();
        const stat = await lstat(config.socketPath);
        const parent = await lstat(dirname(config.socketPath));
        if (
          !stat.isSocket() ||
          stat.uid !== config.producerUid ||
          stat.gid !== config.socketGroup ||
          (stat.mode & 0o7777) !== 0o660 ||
          !parent.isDirectory() ||
          parent.uid !== config.producerUid ||
          parent.gid !== config.socketGroup ||
          (parent.mode & 0o7777) !== 0o710
        )
          throw new Error();
        for (let ancestor = dirname(dirname(config.socketPath)); ; ancestor = dirname(ancestor)) {
          const info = await lstat(ancestor);
          if (
            !info.isDirectory() ||
            ![0, config.producerUid].includes(info.uid) ||
            ((info.mode & 0o022) !== 0 && !(info.uid === 0 && info.mode & 0o1000))
          )
            throw new Error();
          if (ancestor === dirname(ancestor)) break;
        }
        const bytes = Buffer.from(JSON.stringify(data));
        if (bytes.length > MAX_BYTES) throw new Error();
        const result = await new Promise<z.infer<typeof reply>>((done, fail) => {
          const req = request(
            {
              socketPath: config.socketPath,
              method: 'POST',
              path: '/assessment/request',
              headers: { 'content-type': 'application/json', 'content-length': bytes.length },
              agent: false,
            },
            (res) => {
              let response = Buffer.alloc(0);
              res.on('data', (chunk: Buffer) => {
                response = Buffer.concat([response, chunk]);
                if (response.length > 2048) req.destroy(new Error('Producer response refused'));
              });
              res.on('error', fail);
              res.on('aborted', () => fail(new Error('Producer response refused')));
              res.on('end', () => {
                try {
                  if (
                    res.headers['content-type'] !== 'application/json' ||
                    res.headers['content-encoding']
                  )
                    throw new Error();
                  const parsed = reply.parse(
                    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response)),
                  );
                  if (res.statusCode !== 200 && 'data' in parsed) throw new Error();
                  done(parsed);
                } catch {
                  fail(new Error('Producer response refused'));
                }
              });
            },
          );
          const timer = setTimeout(
            () => req.destroy(new Error('Producer response refused')),
            DEADLINE_MS + 1000,
          );
          req.once('close', () => clearTimeout(timer));
          req.on('error', fail);
          req.end(bytes, () => bytes.fill(0));
        });
        if ('data' in result) {
          if (result.data.job_id !== data.request.operationKey.toLowerCase()) throw new Error();
          return result.data;
        }
        if (result.error === 'assessment_questionnaire_mismatch')
          throw new AssessmentQuestionnaireRefused();
        if (result.error !== 'assessment_request_unconfirmed')
          throw new AssessmentContextRefused(result.error);
        throw new Error();
      } catch (error) {
        if (
          error instanceof AssessmentQuestionnaireRefused ||
          error instanceof AssessmentContextRefused
        )
          throw error;
        throw new DispatchRefused();
      }
    },
  });
}

export async function loadAssessmentProducerSocket(filename: string | undefined) {
  if (filename === undefined) return undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = await readControllerFile(filename);
    return assessmentProducerSocketClient(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Assessment producer socket startup refused');
  } finally {
    bytes?.fill(0);
  }
}
