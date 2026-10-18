import { request } from 'node:http';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssessmentRequestSchema } from '@axiom/types';
import {
  assessmentProducerSocketClient,
  loadAssessmentProducerSocket,
  startAssessmentProducerSocket,
} from './assessment-producer-socket.js';
import { AssessmentContextRefused, AssessmentQuestionnaireRefused } from './assessment-producer.js';

const id = (n: number) => `45450000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const value = AssessmentRequestSchema.parse({ operationKey: id(3), engagementId: id(4) });
const receipt = { job_id: id(3), run_id: id(5), expires_at: '2026-12-01T00:00:00Z' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(deadlineMs = 5000) {
  const directory = await realpath(await mkdtemp('/tmp/ax-producer-'));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const producer = { request: vi.fn(async (_t: string, _a: string, _r: unknown) => receipt) };
  const socket = await startAssessmentProducerSocket({
    directory,
    socketGroup: process.getgid!(),
    producer,
    deadlineMs,
  });
  cleanup.push(() => socket.close());
  const config = {
    schemaVersion: 1,
    socketPath: socket.socketPath,
    producerUid: process.getuid!(),
    socketGroup: process.getgid!(),
    tenantIds: [id(1)],
  };
  return { ...socket, directory, producer, config, client: assessmentProducerSocketClient(config) };
}
function call(socketPath: string, body: unknown, path = '/assessment/request') {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const req = request(
      { socketPath, method: 'POST', path, headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => done({ status: res.statusCode!, body }));
      },
    );
    req.on('error', fail);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
describe('local assessment producer sidecar', () => {
  it('carries authenticated actor, tenant and stable request through a group-restricted Unix socket', async () => {
    const f = await fixture();
    expect(await f.client.request(id(1), id(2), value)).toEqual(receipt);
    expect(f.producer.request).toHaveBeenCalledWith(id(1), id(2), value);
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o710);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o660);
    expect(f.client.configurationForTenant?.(id(1))).toBe(true);
    expect(f.client.configurationForTenant?.(id(8))).toBe(false);
  });
  it('refuses another tenant before calling the producer', async () => {
    const f = await fixture();
    await expect(f.client.request(id(8), id(2), value)).rejects.toThrow();
    expect(f.producer.request).not.toHaveBeenCalled();
  });
  it.each(['questionnaire', 'context'])('preserves safe %s refusals', async (kind) => {
    const f = await fixture();
    f.producer.request.mockRejectedValue(
      kind === 'questionnaire'
        ? new AssessmentQuestionnaireRefused()
        : new AssessmentContextRefused('assessment_already_recorded'),
    );
    await expect(f.client.request(id(1), id(2), value)).rejects.toBeInstanceOf(
      kind === 'questionnaire' ? AssessmentQuestionnaireRefused : AssessmentContextRefused,
    );
  });
  it.each([
    'not-json',
    'x'.repeat(133000),
    { tenantId: id(1), actorId: id(2), request: value, credential: 'private-marker' },
  ])('refuses malformed, oversized and unexpected input without calling backend', async (body) => {
    const f = await fixture();
    const result = await call(f.socketPath, body);
    expect(result.status).toBe(503);
    expect(result.body).not.toContain('private-marker');
    expect(f.producer.request).not.toHaveBeenCalled();
  });
  it('refuses controller endpoints and query strings', async () => {
    const f = await fixture();
    for (const path of ['/assessment/run', '/assessment/request?tenant=other'])
      expect((await call(f.socketPath, {}, path)).status).toBe(503);
    expect(f.producer.request).not.toHaveBeenCalled();
  });
  it('refuses a producer receipt for a different operation', async () => {
    const f = await fixture();
    f.producer.request.mockResolvedValue({ ...receipt, job_id: id(9) });
    await expect(f.client.request(id(1), id(2), value)).rejects.toThrow();
  });
  it('sanitizes backend errors and responses', async () => {
    const f = await fixture();
    f.producer.request.mockRejectedValue(new Error('private-marker'));
    const result = await call(f.socketPath, { tenantId: id(1), actorId: id(2), request: value });
    expect(result.status).toBe(503);
    expect(result.body).not.toContain('private-marker');
    f.producer.request.mockResolvedValue({
      ...receipt,
      privateInput: 'private-marker',
    } as typeof receipt);
    await expect(f.client.request(id(1), id(2), value)).rejects.toThrow();
  });
  it('refuses a socket whose permissions or owner no longer match the deployment', async () => {
    const f = await fixture();
    await chmod(f.socketPath, 0o666);
    await expect(f.client.request(id(1), id(2), value)).rejects.toThrow();
    expect(f.producer.request).not.toHaveBeenCalled();
  });
  it('holds the operation slot after a deadline until the actual enqueue settles', async () => {
    const f = await fixture(100);
    let release!: () => void;
    f.producer.request.mockImplementation(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return receipt;
    });
    await f.client.request(id(1), id(2), value).catch(() => undefined);
    await expect(f.client.request(id(1), id(2), value)).rejects.toThrow();
    expect(f.producer.request).toHaveBeenCalledTimes(1);
    release();
    await new Promise((done) => setTimeout(done, 20));
  });
  it('withholds a missing deployment and refuses an unreadable configured file', async () => {
    expect(await loadAssessmentProducerSocket(undefined)).toBeUndefined();
    await expect(loadAssessmentProducerSocket('/nonexistent/producer.json')).rejects.toThrow(
      'startup refused',
    );
  });
});
