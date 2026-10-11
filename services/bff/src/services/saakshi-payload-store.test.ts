import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { describe, expect, it, vi } from 'vitest';
import {
  createScopedTemporaryPayloadStore,
  createScopedStageClaim,
} from './saakshi-payload-store.js';
import {
  encryptTemporaryHumanPayload,
  createEncryptedRetainedResourceReader,
} from './saakshi-temporary-payload.js';
import { resolveRetainedHumanBytes, type StageBinding } from './saakshi-staging-port.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const raw = Buffer.from('owned payload store test bytes');
const hash = createHash('sha256').update(raw).digest('hex');
const now = Date.now();
const key = { id: 'owned-test', key: Buffer.alloc(32, 3), otherKeys: [Buffer.alloc(32, 4)] };
const binding: StageBinding = {
  source: {
    purpose: 'saakshi_owned_resource_stage_v1',
    tenant_id: id,
    actor_id: id,
    engagement_id: null,
    operation_id: id,
    operation_key: id,
    owned_resource_id: id,
    human_request_hash: hash,
    provider: 's3-compatible',
    bucket: 'owned-test',
    object_key: `tenants/${id}/evidence-ingestions/${id}/${hash}`,
    content_hash: hash,
    byte_size: raw.length,
    retain_until: '2034-01-01T00:00:00Z',
    legal_hold: false,
    encryption: 'AES256',
  },
  runId: id,
  correlationId: id,
  requestedReceipt: '123',
};
function fixture() {
  const encrypted = encryptTemporaryHumanPayload(
    {
      sourceKind: 'human_uploaded_bytes',
      tenantId: id,
      actorId: id,
      engagementId: null,
      operationKey: id,
      bodyHash: hash,
      contentHash: hash,
      byteSize: raw.length,
      contentType: 'text/plain',
      retention: {
        provider: 's3-compatible',
        bucket: 'owned-test',
        lockMode: 'COMPLIANCE',
        retentionPolicy: 'seven_years',
        encryption: 'AES256',
        legalHold: false,
        acknowledgesImmutableRetention: true,
      },
    },
    raw,
    key,
    { now },
  );
  const m = encrypted.metadata;
  const row = {
    id,
    binding: structuredClone(binding),
    originalApproval: m.originalApproval,
    algorithm: m.algorithm,
    keyId: m.keyId,
    nonce: m.nonce.toString('hex'),
    tag: m.tag.toString('hex'),
    ciphertextHash: m.cipherHash,
    ciphertextSize: m.cipherSize,
    createdAt: new Date(m.createdAt).toISOString(),
    expiresAt: new Date(m.expiresAt).toISOString(),
    purged: false,
    ciphertextHex: encrypted.ciphertext.toString('hex'),
  };
  const call = vi.fn(async (name: string) => ({
    data: name === 'read_saakshi119_payload' ? row : true,
    error: null as unknown,
  }));
  return { row, call, store: createScopedTemporaryPayloadStore({ call }) };
}
describe('scoped encrypted payload reader', () => {
  it('binds exact server generated source and original encrypted bytes without raw transport', async () => {
    const f = fixture();
    const body = await resolveRetainedHumanBytes(
      binding,
      createEncryptedRetainedResourceReader(f.store, key, () => now),
      new AbortController().signal,
    );
    expect(body.body).toEqual(raw);
    expect(JSON.stringify(f.row)).not.toContain(raw.toString());
    expect(f.call).toHaveBeenCalledWith(
      'read_saakshi119_payload',
      {
        t: id,
        a: id,
        runid: id,
        k: id,
        ih: createHash('sha256').update(canonicalJson(binding.source)).digest('hex'),
      },
      expect.any(AbortSignal),
    );
  });
  it.each(['run', 'receipt', 'actor', 'input', 'cipher', 'size', 'purged', 'unknown'])(
    'refuses %s drift before plaintext',
    async (kind) => {
      const f = fixture();
      if (kind === 'run') f.row.binding.runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      if (kind === 'receipt') f.row.binding.requestedReceipt = '124';
      if (kind === 'actor') f.row.binding.source.actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      if (kind === 'input') f.row.binding.source.human_request_hash = '0'.repeat(64);
      if (kind === 'cipher') f.row.ciphertextHex = '00'.repeat(raw.length);
      if (kind === 'size') f.row.ciphertextSize++;
      if (kind === 'purged') f.row.purged = true;
      if (kind === 'unknown') Object.assign(f.row, { rawBody: 'should-not-exist' });
      await expect(
        resolveRetainedHumanBytes(
          binding,
          createEncryptedRetainedResourceReader(f.store, key, () => now),
          new AbortController().signal,
        ),
      ).rejects.toThrow('unconfirmed');
    },
  );
  it('binds current ciphertext digest and exact source to fresh check', async () => {
    const f = fixture();
    expect(
      await f.store.current(id, binding, f.row.ciphertextHash, new AbortController().signal),
    ).toBe(true);
    expect(f.call).toHaveBeenCalledWith(
      'current_saakshi119_payload',
      expect.objectContaining({
        payloadid: id,
        ch: f.row.ciphertextHash,
        ih: createHash('sha256').update(canonicalJson(binding.source)).digest('hex'),
      }),
      expect.any(AbortSignal),
    );
  });
  it('requires literal current true, not truthy provider values', async () => {
    const f = fixture();
    f.call.mockResolvedValue({ data: 'true' as never, error: null });
    expect(await f.store.current(id, binding, hash, new AbortController().signal)).toBe(false);
  });
  it('sanitizes provider errors and does not expose ciphertext', async () => {
    const f = fixture();
    f.call.mockResolvedValue({ data: null as never, error: { message: f.row.ciphertextHex } });
    await expect(f.store.lease(binding, new AbortController().signal)).rejects.toThrow(
      'unconfirmed',
    );
  });
  it('refuses abort after read transport returns', async () => {
    const f = fixture();
    const c = new AbortController();
    f.call.mockImplementation(async () => {
      c.abort();
      return { data: f.row, error: null };
    });
    await expect(f.store.lease(binding, c.signal)).rejects.toThrow('unconfirmed');
  });
  it('ends an unresponsive scoped reader at abort without exposing pending data', async () => {
    const f = fixture();
    const c = new AbortController();
    f.call.mockImplementation(() => new Promise(() => undefined));
    const pending = f.store.lease(binding, c.signal);
    c.abort();
    await expect(pending).rejects.toThrow('unconfirmed');
  });
  it('refuses altered source receipt at internal lease boundary before decrypt', async () => {
    const f = fixture();
    f.row.binding.requestedReceipt = '999';
    await expect(f.store.lease(binding, new AbortController().signal)).rejects.toThrow(
      'unconfirmed',
    );
  });
  it('refuses corrupted cipher at internal lease boundary before decrypt', async () => {
    const f = fixture();
    f.row.ciphertextHex = '00'.repeat(raw.length);
    await expect(f.store.lease(binding, new AbortController().signal)).rejects.toThrow(
      'unconfirmed',
    );
  });
  it('consumes exact source lease and preserves database expiry', async () => {
    const inputHash = createHash('sha256').update(canonicalJson(binding.source)).digest('hex');
    const expiry = Date.now() + 1000;
    const call = vi.fn(async () => ({
      data: { mode: 'upload_once', run_id: id, input_hash: inputHash, expires_at_ms: expiry },
      error: null,
    }));
    expect(
      await createScopedStageClaim({ call }).consume(binding, new AbortController().signal),
    ).toEqual({ mode: 'upload_once', expiresAt: expiry });
    expect(call).toHaveBeenCalledWith(
      'consume_saakshi119_upload',
      expect.objectContaining({ runid: id, ih: inputHash }),
      expect.any(AbortSignal),
    );
  });
  it.each(['run', 'hash', 'expired', 'mode'])('refuses claimed %s drift', async (kind) => {
    const row = {
      mode: 'upload_once',
      run_id: id,
      input_hash: createHash('sha256').update(canonicalJson(binding.source)).digest('hex'),
      expires_at_ms: Date.now() + 1000,
    };
    if (kind === 'run') row.run_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (kind === 'hash') row.input_hash = '0'.repeat(64);
    if (kind === 'expired') row.expires_at_ms = 1;
    if (kind === 'mode') row.mode = 'upload_again';
    await expect(
      createScopedStageClaim({ call: async () => ({ data: row, error: null }) }).consume(
        binding,
        new AbortController().signal,
      ),
    ).rejects.toThrow('unconfirmed');
  });
});
