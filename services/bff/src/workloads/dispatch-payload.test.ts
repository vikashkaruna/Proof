import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { TaskProof } from './tasks.js';
import { AssessmentDispatch } from './assessment-dispatch.js';
import {
  sealDispatch,
  openDispatch,
  type DispatchContext,
  type DispatchKeyWrapper,
} from './dispatch-payload.js';
const id = (n: number) => `67670000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = JSON.stringify({
  tenant_id: id(1),
  engagement_id: id(2),
  library_version: 'synthetic-v1',
  answers: { X: { Q: 'synthetic-private-answer' } },
});
const context: DispatchContext = {
  jobId: id(3),
  tenantId: id(1),
  actorId: id(4),
  workloadId: id(5),
  estateId: null,
  engagementId: id(2),
  correlationId: id(6),
  inputHash: createHash('sha256').update(input).digest('hex'),
};
function fixture() {
  const master = randomBytes(32),
    proof = new TaskProof(randomBytes(32).toString('base64url'));
  const wrapper: DispatchKeyWrapper = {
    async wrap(aad, key) {
      const nonce = randomBytes(12),
        c = createCipheriv('aes-256-gcm', master, nonce);
      c.setAAD(aad);
      return {
        keyRef: 'synthetic-key/v1',
        wrappedKey: Buffer.concat([nonce, c.update(key), c.final(), c.getAuthTag()]),
      };
    },
    async unwrap(aad, ref, bytes) {
      expect(ref).toBe('synthetic-key/v1');
      const b = Buffer.from(bytes),
        d = createDecipheriv('aes-256-gcm', master, b.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]);
    },
  };
  return { proof, wrapper, hash: createHash('sha256').update(proof.reveal()).digest('hex') };
}
describe('private dispatch payload', () => {
  it('authenticates exact input and proof; ordinary serialization and inspection hide both', async () => {
    const f = fixture(),
      sealed = await sealDispatch(context, input, f.proof, f.wrapper);
    expect(JSON.stringify(sealed)).not.toContain('synthetic-private-answer');
    const p = await openDispatch(context, sealed, f.hash, f.wrapper);
    expect(p.reveal()).toEqual({ inputJson: input, taskProof: f.proof.reveal() });
    for (const text of [JSON.stringify(p), inspect(p), String(p), JSON.stringify({ ...p })]) {
      expect(text).not.toContain(input);
      expect(text).not.toContain(f.proof.reveal());
      expect(text).not.toContain('synthetic-private-answer');
    }
  });
  it('canonicalizes UUID context so SQL normalization cannot strand a payload', async () => {
    const f = fixture();
    const c = { ...context, jobId: 'abcdefab-abcd-4abc-8abc-abcdefabcdef' };
    const sealed = await sealDispatch(
      { ...c, jobId: c.jobId.toUpperCase() },
      input,
      f.proof,
      f.wrapper,
    );
    expect((await openDispatch(c, sealed, f.hash, f.wrapper)).reveal().inputJson).toBe(input);
  });
  it.each([
    'jobId',
    'tenantId',
    'actorId',
    'workloadId',
    'estateId',
    'engagementId',
    'correlationId',
    'inputHash',
  ] as const)('refuses swapped %s', async (key) => {
    const f = fixture(),
      sealed = await sealDispatch(context, input, f.proof, f.wrapper);
    await expect(
      openDispatch(
        { ...context, [key]: key === 'inputHash' ? 'f'.repeat(64) : id(9) },
        sealed,
        f.hash,
        f.wrapper,
      ),
    ).rejects.toThrow('Private assessment dispatch was refused.');
  });
  it.each(['nonce', 'ciphertext', 'wrapped_key', 'key_ref'] as const)(
    'refuses tampered %s',
    async (key) => {
      const f = fixture(),
        sealed = await sealDispatch(context, input, f.proof, f.wrapper);
      const value = sealed[key];
      await expect(
        openDispatch(
          context,
          {
            ...sealed,
            [key]:
              key === 'key_ref'
                ? 'other-key'
                : (value.startsWith('aa') ? 'bb' : 'aa') + value.slice(2),
          },
          f.hash,
          f.wrapper,
        ),
      ).rejects.toThrow('Private assessment dispatch was refused.');
    },
  );
  it('refuses conflicting proof hash and wire input', async () => {
    const f = fixture(),
      sealed = await sealDispatch(context, input, f.proof, f.wrapper);
    await expect(openDispatch(context, sealed, 'f'.repeat(64), f.wrapper)).rejects.toThrow();
    await expect(sealDispatch(context, input + ' ', f.proof, f.wrapper)).rejects.toThrow();
  });
  it('clears provider-owned data keys and sanitizes provider errors', async () => {
    const f = fixture();
    let wrappingKey: Uint8Array | undefined, unwrappedKey: Uint8Array | undefined;
    const wrapper: DispatchKeyWrapper = {
      async wrap(c, k) {
        wrappingKey = k;
        return f.wrapper.wrap(c, k);
      },
      async unwrap(c, r, k) {
        unwrappedKey = await f.wrapper.unwrap(c, r, k);
        return unwrappedKey;
      },
    };
    const sealed = await sealDispatch(context, input, f.proof, wrapper);
    expect(wrappingKey?.every((v) => v === 0)).toBe(true);
    await openDispatch(context, sealed, f.hash, wrapper);
    expect(unwrappedKey?.every((v) => v === 0)).toBe(true);
    wrapper.unwrap = async () => {
      throw new Error('private-provider-detail');
    };
    await expect(openDispatch(context, sealed, f.hash, wrapper)).rejects.toThrow(
      'Private assessment dispatch was refused.',
    );
  });
});
describe('trusted durable dispatch adapter', () => {
  it('stores only ciphertext and a proof hash; retries use the same job identity', async () => {
    const f = fixture(),
      fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              job_id: context.jobId,
              run_id: id(7),
              expires_at: new Date(Date.now() + 200000).toISOString(),
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
    const db = createClient('http://synthetic.invalid', 'synthetic', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    });
    const dispatch = new AssessmentDispatch(db, f.wrapper);
    const a = await dispatch.enqueue(context, input),
      b = await dispatch.enqueue(context, input);
    expect(a.run_id).toBe(b.run_id);
    for (const call of fetcher.mock.calls) {
      const body = String(call[1]?.body);
      expect(body).not.toContain('synthetic-private-answer');
      expect(JSON.parse(body).p_job_id).toBe(context.jobId);
    }
  });
  it('decrypts a single claimed delivery and binds the SQL task proof', async () => {
    const f = fixture(),
      sealed = await sealDispatch(context, input, f.proof, f.wrapper);
    const row = {
      ...sealed,
      job_id: context.jobId,
      tenant_id: context.tenantId,
      run_id: id(7),
      actor_id: context.actorId,
      workload_id: context.workloadId,
      estate_id: null,
      engagement_id: context.engagementId,
      correlation_id: context.correlationId,
      input_hash: context.inputHash,
      proof_hash: f.hash,
      expires_at: new Date(Date.now() + 200000).toISOString(),
    };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(row), { headers: { 'content-type': 'application/json' } }),
    );
    const db = createClient('http://synthetic.invalid', 'synthetic', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    });
    const claimed = await new AssessmentDispatch(db, f.wrapper).claim(
      context.tenantId,
      context.jobId,
    );
    expect(claimed.payload.reveal().inputJson).toBe(input);
    expect(claimed.runId).toBe(id(7));
    row.proof_hash = 'f'.repeat(64);
    await expect(
      new AssessmentDispatch(db, f.wrapper).claim(context.tenantId, context.jobId),
    ).rejects.toThrow();
  });
  it.each([{ error: 'dispatch_reconciliation_required' }, null, { message: 'private-detail' }])(
    'refuses missing or already claimed deliveries without exposing database detail',
    async (reply) => {
      const f = fixture(),
        db = createClient('http://synthetic.invalid', 'synthetic', {
          global: {
            fetch: async () =>
              new Response(JSON.stringify(reply), {
                headers: { 'content-type': 'application/json' },
              }),
          },
          auth: { persistSession: false },
        });
      await expect(
        new AssessmentDispatch(db, f.wrapper).claim(context.tenantId, context.jobId),
      ).rejects.toThrow('Private assessment dispatch was refused.');
    },
  );
});
