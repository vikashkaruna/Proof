import { canonicalJson } from '@axiom/ledger';
import { createHash, createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveRetainedHumanBytes, type StageBinding } from './saakshi-staging-port.js';
import {
  encryptTemporaryHumanPayload,
  createEncryptedRetainedResourceReader,
  type TemporaryPayloadKey,
  type TemporaryPayloadRecord,
  type TemporaryPayloadStore,
} from './saakshi-temporary-payload.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bytes = Buffer.from('owned temporary human bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const now = Date.parse('2026-10-08T09:00:00Z');
const key: TemporaryPayloadKey = {
  id: 'owned-test-key',
  key: Buffer.alloc(32, 3),
  otherKeys: [Buffer.alloc(32, 4)],
};
function binding(): StageBinding {
  return {
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
      bucket: 'owned-payload-fixture',
      object_key: `tenants/${id}/evidence-ingestions/${id}/${hash}`,
      content_hash: hash,
      byte_size: bytes.length,
      retain_until: '2034-01-01T00:00:00Z',
      legal_hold: false,
      encryption: 'AES256',
    },
    runId: id,
    correlationId: id,
    requestedReceipt: '2345',
  };
}
function approval() {
  const b = binding();
  return {
    sourceKind: 'human_uploaded_bytes' as const,
    tenantId: b.source.tenant_id,
    actorId: b.source.actor_id,
    engagementId: b.source.engagement_id,
    operationKey: b.source.operation_key,
    bodyHash: b.source.human_request_hash,
    contentHash: b.source.content_hash,
    byteSize: b.source.byte_size,
    contentType: 'text/plain',
    retention: {
      provider: b.source.provider,
      bucket: b.source.bucket,
      lockMode: 'COMPLIANCE' as const,
      retentionPolicy: 'seven_years' as const,
      encryption: b.source.encryption,
      legalHold: b.source.legal_hold,
      acknowledgesImmutableRetention: true as const,
    },
  };
}
function fixture() {
  const sealed = encryptTemporaryHumanPayload(approval(), bytes, key, { now });
  let current = true;
  let opens = 0;
  const record: TemporaryPayloadRecord = {
    ...sealed.metadata,
    id,
    binding: binding(),
    purged: false,
    async *open() {
      opens++;
      yield sealed.ciphertext;
    },
  };
  const store: TemporaryPayloadStore = {
    async lease() {
      return record;
    },
    async current() {
      return current;
    },
  };
  return {
    sealed,
    record,
    store,
    opens: () => opens,
    purge: () => {
      current = false;
      record.purged = true;
    },
  };
}
describe('bounded temporary payload encryption (unwired lifecycle)', () => {
  it('decrypts authenticated exact source only; ciphertext differs from human bytes', async () => {
    const f = fixture();
    const reader = createEncryptedRetainedResourceReader(f.store, key, () => now);
    expect(f.sealed.ciphertext).not.toEqual(bytes);
    expect(f.sealed.metadata).not.toHaveProperty('human_body_text');
    expect(f.sealed.metadata).not.toHaveProperty('contentBase64');
    expect(f.sealed.metadata).not.toHaveProperty('key');
    expect(
      (await resolveRetainedHumanBytes(binding(), reader, new AbortController().signal)).body,
    ).toEqual(bytes);
  });
  it('uses distinct nonces for two equal approved sources', () => {
    expect(fixture().record.nonce).not.toEqual(fixture().record.nonce);
  });
  it.each(['nonce', 'tag', 'cipherHash', 'keyId', 'binding', 'originalApproval'] as const)(
    'refuses modified authenticated field %s',
    async (field) => {
      const f = fixture();
      if (field === 'nonce' || field === 'tag')
        f.record[field] = Buffer.alloc(f.record[field].length, 0);
      else if (field === 'binding')
        f.record.binding = { ...binding(), runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      else if (field === 'originalApproval')
        f.record.originalApproval = { ...approval(), contentType: 'text/html' };
      else f.record[field] = field === 'cipherHash' ? 'f'.repeat(64) : 'foreign-key';
      await expect(
        createEncryptedRetainedResourceReader(f.store, key, () => now).read(
          binding(),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Evidence staging is unconfirmed');
    },
  );
  it('refuses swapping valid ciphertext from another human approval even with matching size/content digest', async () => {
    const f = fixture();
    const foreign = encryptTemporaryHumanPayload(
      {
        ...approval(),
        bodyHash: 'a'.repeat(64),
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      bytes,
      key,
      { now },
    );
    f.record.nonce = foreign.metadata.nonce;
    f.record.tag = foreign.metadata.tag;
    f.record.cipherHash = foreign.metadata.cipherHash;
    f.record.open = async function* () {
      yield foreign.ciphertext;
    };
    await expect(
      createEncryptedRetainedResourceReader(f.store, key, () => now).read(
        binding(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Evidence staging is unconfirmed');
  });
  it('contains no generated intent/run/receipt hints or raw HTTP body in pre-encryption approval', () => {
    const encrypted = encryptTemporaryHumanPayload(approval(), bytes, key, { now });
    expect(encrypted.metadata).not.toHaveProperty('binding');
    expect(encrypted.metadata).not.toHaveProperty('id');
    expect(encrypted.metadata.originalApproval).not.toHaveProperty('runId');
    expect(() =>
      encryptTemporaryHumanPayload(
        { ...approval(), humanBodyText: 'forbidden' } as never,
        bytes,
        key,
        { now },
      ),
    ).toThrow();
  });
  it('refuses modified ciphertext even with a recomputed ciphertext digest (GCM tag)', async () => {
    const f = fixture();
    f.sealed.ciphertext[0] = f.sealed.ciphertext[0]! ^ 1;
    f.record.cipherHash = createHash('sha256').update(f.sealed.ciphertext).digest('hex');
    await expect(
      createEncryptedRetainedResourceReader(f.store, key, () => now).read(
        binding(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Evidence staging is unconfirmed');
  });
  it('refuses wrong plaintext despite valid source-bound GCM authentication and cipher digest', async () => {
    const f = fixture();
    const cipher = createCipheriv('aes-256-gcm', key.key, f.record.nonce);
    cipher.setAAD(Buffer.from('axiom-saakshi-temporary-payload-v1\0' + canonicalJson(approval())));
    const wrong = Buffer.concat([cipher.update(Buffer.alloc(bytes.length)), cipher.final()]);
    f.record.tag = cipher.getAuthTag();
    f.record.cipherHash = createHash('sha256').update(wrong).digest('hex');
    f.record.open = async function* () {
      yield wrong;
    };
    await expect(
      createEncryptedRetainedResourceReader(f.store, key, () => now).read(
        binding(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Evidence staging is unconfirmed');
  });
  it.each([0, 15 * 60000 + 1])('refuses invalid payload lifetime %s', (lifetimeMs) => {
    expect(() => encryptTemporaryHumanPayload(approval(), bytes, key, { now, lifetimeMs })).toThrow(
      'Evidence staging is unconfirmed',
    );
  });
  it('refuses payload key reuse with a peer/source key', () => {
    expect(() =>
      createEncryptedRetainedResourceReader(
        fixture().store,
        { ...key, otherKeys: [key.key] },
        () => now,
      ),
    ).toThrow();
  });
  it('refuses bytes not approved by exact source hash/size', () => {
    expect(() =>
      encryptTemporaryHumanPayload(approval(), Buffer.alloc(bytes.length), key, {
        now,
      }),
    ).toThrow();
  });
  it.each(['expired', 'purged', 'excessive-lifetime'] as const)(
    'refuses %s payload before opening bytes',
    async (state) => {
      const f = fixture();
      if (state === 'purged') f.purge();
      else if (state === 'expired') {
        f.record.createdAt = now - 30_000;
        f.record.expiresAt = now;
      } else f.record.expiresAt = now + 15 * 60000 + 1;
      await expect(
        createEncryptedRetainedResourceReader(f.store, key, () => now).read(
          binding(),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(f.opens()).toBe(0);
    },
  );
  it('refuses purge between authenticated decryption and current readback', async () => {
    const f = fixture();
    f.store.current = async () => {
      f.purge();
      return false;
    };
    await expect(
      createEncryptedRetainedResourceReader(f.store, key, () => now).read(
        binding(),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it('refuses a stale returned lease after purge before any plaintext is emitted', async () => {
    const f = fixture();
    const reader = createEncryptedRetainedResourceReader(f.store, key, () => now);
    const resource = await reader.read(binding(), new AbortController().signal);
    f.purge();
    await expect(
      resource.open(new AbortController().signal)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow();
  });
  it('refuses expiry while a ciphertext stream is still pending', async () => {
    const f = fixture();
    let clock = now;
    f.record.open = async function* () {
      yield f.sealed.ciphertext.subarray(0, 2);
      clock = now + 15 * 60000;
      yield f.sealed.ciphertext.subarray(2);
    };
    await expect(
      createEncryptedRetainedResourceReader(f.store, key, () => clock).read(
        binding(),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it.each(['oversized', 'truncated'] as const)(
    'refuses %s ciphertext before exposure',
    async (mode) => {
      const f = fixture();
      f.record.open = async function* () {
        yield mode === 'oversized'
          ? Buffer.concat([f.sealed.ciphertext, Buffer.from('x')])
          : f.sealed.ciphertext.subarray(1);
      };
      await expect(
        createEncryptedRetainedResourceReader(f.store, key, () => now).read(
          binding(),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    },
  );
  it('observes cancellation of a hung ciphertext stream', async () => {
    const f = fixture();
    f.record.open = () => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    });
    const signal = new AbortController();
    const pending = createEncryptedRetainedResourceReader(f.store, key, () => now).read(
      binding(),
      signal.signal,
    );
    signal.abort();
    await expect(pending).rejects.toThrow('Evidence staging is unconfirmed');
  });
});
