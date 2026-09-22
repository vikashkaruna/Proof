import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { crc32c } from '@aws-crypto/crc32c';
import { EncryptCommand } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@axiom/types';
import {
  DispatchKeyPolicy,
  dispatchKmsBinding,
  type DispatchKeyProvider,
} from './dispatch-key-policy.js';
import {
  AwsDispatchKeyWrapper,
  GcpDispatchKeyWrapper,
  type DispatchAwsKmsPort,
  type DispatchGcpKmsPort,
} from './dispatch-key-wrappers.js';
import {
  dispatchWrappingContext,
  sealDispatch,
  openDispatch,
  type DispatchContext,
} from './dispatch-payload.js';
import { TaskProof } from './tasks.js';

const id = (n: number) => `abab0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1) as TenantId;
const foreign = id(2) as TenantId;
const aws = (n: number) =>
  `arn:aws:kms:ap-south-1:123456789012:key/${id(n).replace('abab', 'cdcd')}`;
const gcp = (n: number) =>
  `projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-${n}`;
const input = JSON.stringify({
  tenant_id: tenant,
  engagement_id: id(7),
  library_version: 'synthetic-v1',
  answers: { X: { Q: 'private-test-answer' } },
});
const context: DispatchContext = {
  jobId: id(3),
  tenantId: tenant,
  actorId: id(4),
  workloadId: id(5),
  estateId: id(6),
  engagementId: id(7),
  correlationId: id(8),
  inputHash: createHash('sha256').update(input).digest('hex'),
};
const aad = dispatchWrappingContext(context);
const policy = (provider: DispatchKeyProvider) =>
  new DispatchKeyPolicy(
    provider,
    new Map([[tenant, { primary: provider === 'aws' ? aws(1) : gcp(1), retiring: [] }]]),
  );
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dispatch KMS policy and binding', () => {
  it('validates the canonical context and sends only a purpose-separated digest to KMS', () => {
    const binding = dispatchKmsBinding(aad);
    expect(binding.tenant).toBe(tenant);
    expect(binding.digest).toBe(createHash('sha256').update(aad).digest('hex'));
    expect(JSON.parse(binding.aad.toString())).toEqual([
      'axiom.assessment.dispatch.kms',
      1,
      binding.digest,
    ]);
    expect(binding.aad.toString()).not.toContain(tenant);
    expect(binding.aad.toString()).not.toContain(context.inputHash);
  });
  it.each([
    'purpose',
    'version',
    'short',
    'extra',
    'space',
    'case',
    'uuid',
    'hash',
    'utf8',
    'size',
  ])('refuses malformed/noncanonical context (%s) before IO', async (fault) => {
    const values: unknown[] = JSON.parse(aad.toString());
    if (fault === 'purpose') values[0] = 'axiom.credential.dek';
    if (fault === 'version') values[1] = 2;
    if (fault === 'short') values.pop();
    if (fault === 'extra') values.push('private');
    if (fault === 'case') values[3] = tenant.toUpperCase();
    if (fault === 'uuid') values[2] = 'invalid';
    if (fault === 'hash') values[9] = 'x'.repeat(64);
    const bytes =
      fault === 'utf8'
        ? Buffer.from([0xff])
        : fault === 'size'
          ? Buffer.alloc(4097)
          : Buffer.from(JSON.stringify(values) + (fault === 'space' ? ' ' : ''));
    const client: DispatchAwsKmsPort = { send: vi.fn() };
    await expect(
      new AwsDispatchKeyWrapper(policy('aws'), client).wrap(bytes, randomBytes(32)),
    ).rejects.toThrow('Private assessment dispatch was refused.');
    expect(client.send).not.toHaveBeenCalled();
  });
  it.each(['aws', 'gcp'] as const)(
    'retains old %s keys, snapshots policy and refuses cross-tenant reuse',
    (provider) => {
      const ref = provider === 'aws' ? aws : gcp;
      const old = policy(provider),
        next = old.withReadable(tenant, ref(2)).withPrimary(tenant, ref(2));
      expect(old.primary(tenant)).toBe(ref(1));
      expect(() => old.withPrimary(tenant, ref(2))).toThrow();
      expect(old.withReadable(tenant, ref(2)).primary(tenant)).toBe(ref(1));
      expect(next.primary(tenant)).toBe(ref(2));
      expect(() => next.requireReadable(tenant, ref(1))).not.toThrow();
      const snapshot = next.snapshot();
      snapshot.set(tenant, { primary: ref(9), retiring: [] });
      expect(next.primary(tenant)).toBe(ref(2));
      expect(() => next.requireReadable(tenant, ref(9))).toThrow();
      expect(() => next.requireReadable(foreign, ref(1))).toThrow();
      expect(next.withPrimary(tenant, ref(1)).snapshot().get(tenant)?.retiring).toEqual([ref(2)]);
      const reused = next.snapshot();
      reused.set(foreign, { primary: ref(3), retiring: [ref(1)] });
      expect(() => new DispatchKeyPolicy(provider, reused)).toThrow();
    },
  );
  it.each([
    'foreign-region',
    'alias',
    'version',
    'duplicate',
    'too-many',
    'duplicate-tenant',
    'invalid-tenant',
  ])('refuses unsafe key policy (%s)', (fault) => {
    const rings = new Map([[tenant, { primary: aws(1), retiring: [] as string[] }]]);
    if (fault === 'foreign-region')
      rings.get(tenant)!.primary = aws(1).replace('ap-south-1', 'us-east-1');
    if (fault === 'alias') rings.get(tenant)!.primary = aws(1).replace('key/', 'alias/');
    if (fault === 'version') rings.get(tenant)!.primary += '/cryptoKeyVersions/1';
    if (fault === 'duplicate') rings.get(tenant)!.retiring.push(aws(1));
    if (fault === 'too-many')
      rings.get(tenant)!.retiring = Array.from({ length: 10 }, (_, i) => aws(i + 2));
    if (fault === 'duplicate-tenant')
      rings.set(tenant.toUpperCase() as TenantId, { primary: aws(4), retiring: [] });
    if (fault === 'invalid-tenant')
      rings.set('not-tenant' as TenantId, { primary: aws(4), retiring: [] });
    expect(() => new DispatchKeyPolicy('aws', rings)).toThrow(
      'Private assessment dispatch was refused.',
    );
  });
  it('refuses region/version/endpoint substitutions for GCP and a mismatched provider', () => {
    for (const ref of [
      gcp(1).replace('asia-south1', 'global'),
      gcp(1) + '/cryptoKeyVersions/1',
      'https://evil.invalid/' + gcp(1),
    ]) {
      expect(
        () => new DispatchKeyPolicy('gcp', new Map([[tenant, { primary: ref, retiring: [] }]])),
      ).toThrow();
    }
    expect(() => new AwsDispatchKeyWrapper(policy('gcp'), { send: vi.fn() })).toThrow();
    expect(
      () => new GcpDispatchKeyWrapper(policy('aws'), { encrypt: vi.fn(), decrypt: vi.fn() }),
    ).toThrow();
    expect(() => policy('aws').withPrimary(foreign, aws(9))).toThrow();
    let p = policy('gcp');
    for (let i = 2; i <= 10; i++) p = p.withReadable(tenant, gcp(i)).withPrimary(tenant, gcp(i));
    expect(() => p.withReadable(tenant, gcp(11))).toThrow();
  });
});

/** A local cryptographic provider fixture, not real KMS or IAM acceptance. */
function providerFixture(provider: DispatchKeyProvider) {
  const keys = new Map<string, Buffer>();
  const requests: { keyRef: string; aad: string; plaintext?: Buffer }[] = [];
  function encrypt(ref: string, bytes: Uint8Array, binding: string) {
    const key = keys.get(ref) ?? randomBytes(32);
    keys.set(ref, key);
    requests.push({ keyRef: ref, aad: binding, plaintext: Buffer.from(bytes) });
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(binding));
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }
  function decrypt(ref: string, bytes: Uint8Array, binding: string) {
    requests.push({ keyRef: ref, aad: binding });
    const b = Buffer.from(bytes),
      key = keys.get(ref);
    if (!key) throw new Error('private-key-missing');
    const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    cipher.setAAD(Buffer.from(binding));
    cipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]);
  }
  const awsClient: DispatchAwsKmsPort = {
    send: async (command) => {
      const args = command.input,
        ref = args.KeyId!;
      const binding = JSON.stringify(args.EncryptionContext);
      return command instanceof EncryptCommand
        ? {
            KeyId: ref,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            CiphertextBlob: encrypt(ref, command.input.Plaintext!, binding),
          }
        : {
            KeyId: ref,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            Plaintext: decrypt(ref, command.input.CiphertextBlob!, binding),
          };
    },
  };
  const gcpClient: DispatchGcpKmsPort = {
    encrypt: async (args) => {
      const ciphertext = encrypt(
        args.name!,
        args.plaintext as Uint8Array,
        Buffer.from(args.additionalAuthenticatedData as Uint8Array).toString(),
      );
      return [
        {
          name: args.name + '/cryptoKeyVersions/2',
          ciphertext,
          ciphertextCrc32c: { value: crc32c(ciphertext) },
          verifiedPlaintextCrc32c: true,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        },
      ];
    },
    decrypt: async (args) => {
      const plaintext = decrypt(
        args.name!,
        args.ciphertext as Uint8Array,
        Buffer.from(args.additionalAuthenticatedData as Uint8Array).toString(),
      );
      return [{ plaintext, plaintextCrc32c: { value: crc32c(plaintext) } }];
    },
  };
  return {
    requests,
    wrapper: (p: DispatchKeyPolicy) =>
      provider === 'aws'
        ? new AwsDispatchKeyWrapper(p, awsClient)
        : new GcpDispatchKeyWrapper(p, gcpClient),
  };
}

describe.each(['aws', 'gcp'] as const)(
  '%s dispatch envelope integration with local provider',
  (provider) => {
    it('opens retained ciphertext after rotation/restart and binds each assignment field', async () => {
      const fixture = providerFixture(provider),
        p = policy(provider);
      const proof = new TaskProof(randomBytes(32).toString('base64url'));
      const proofHash = createHash('sha256').update(proof.reveal()).digest('hex');
      const first = await sealDispatch(context, input, proof, fixture.wrapper(p));
      const next = p
        .withReadable(tenant, provider === 'aws' ? aws(2) : gcp(2))
        .withPrimary(tenant, provider === 'aws' ? aws(2) : gcp(2));
      const restarted = fixture.wrapper(new DispatchKeyPolicy(provider, next.snapshot()));
      expect((await openDispatch(context, first, proofHash, restarted)).reveal()).toEqual({
        inputJson: input,
        taskProof: proof.reveal(),
      });
      const second = await sealDispatch(context, input, proof, restarted);
      expect(second.key_ref).toBe(next.primary(tenant));
      expect(second.key_ref).not.toBe(first.key_ref);
      for (const name of Object.keys(context) as (keyof DispatchContext)[]) {
        await expect(
          openDispatch(
            { ...context, [name]: name === 'inputHash' ? '0'.repeat(64) : id(19) },
            first,
            proofHash,
            restarted,
          ),
        ).rejects.toThrow();
      }
      expect(
        fixture.requests.filter((r) => r.plaintext).every((r) => r.plaintext!.length === 32),
      ).toBe(true);
      expect(JSON.stringify(fixture.requests)).not.toContain(tenant);
      expect(JSON.stringify(fixture.requests)).not.toContain('private-test-answer');
      expect(JSON.stringify(fixture.requests)).not.toContain(proof.reveal());
    });
    it('rejects unknown tenants and foreign key references before provider calls', async () => {
      const fixture = providerFixture(provider),
        wrapper = fixture.wrapper(policy(provider));
      await expect(
        wrapper.wrap(dispatchWrappingContext({ ...context, tenantId: foreign }), randomBytes(32)),
      ).rejects.toThrow();
      await expect(
        wrapper.unwrap(aad, provider === 'aws' ? aws(2) : gcp(2), randomBytes(80)),
      ).rejects.toThrow();
      await expect(wrapper.wrap(aad, randomBytes(31))).rejects.toThrow();
      await expect(
        wrapper.unwrap(aad, policy(provider).primary(tenant), new Uint8Array(0)),
      ).rejects.toThrow();
      await expect(
        wrapper.unwrap(aad, policy(provider).primary(tenant), new Uint8Array(16385)),
      ).rejects.toThrow();
      expect(fixture.requests).toEqual([]);
    });
  },
);

describe('dispatch provider response integrity and deadlines', () => {
  it.each(['key', 'algorithm', 'missing', 'oversize'])(
    'refuses invalid AWS wrapping response (%s)',
    async (fault) => {
      const send = vi.fn<DispatchAwsKmsPort['send']>().mockResolvedValue({
        KeyId: fault === 'key' ? aws(9) : aws(1),
        EncryptionAlgorithm: fault === 'algorithm' ? 'other' : 'SYMMETRIC_DEFAULT',
        CiphertextBlob:
          fault === 'missing' ? undefined : randomBytes(fault === 'oversize' ? 16385 : 80),
      });
      await expect(
        new AwsDispatchKeyWrapper(policy('aws'), { send }).wrap(aad, randomBytes(32)),
      ).rejects.toThrow();
    },
  );
  it.each(['success', 'key', 'algorithm', 'size'])(
    'copies and clears AWS returned plaintext (%s)',
    async (fault) => {
      const plaintext = randomBytes(fault === 'size' ? 31 : 32),
        expected = Buffer.from(plaintext);
      const send = vi.fn<DispatchAwsKmsPort['send']>().mockResolvedValue({
        KeyId: fault === 'key' ? aws(9) : aws(1),
        EncryptionAlgorithm: fault === 'algorithm' ? 'other' : 'SYMMETRIC_DEFAULT',
        Plaintext: plaintext,
      });
      const call = new AwsDispatchKeyWrapper(policy('aws'), { send }).unwrap(
        aad,
        aws(1),
        randomBytes(80),
      );
      if (fault === 'success') expect(await call).toEqual(expected);
      else await expect(call).rejects.toThrow();
      expect(plaintext.every((v) => v === 0)).toBe(true);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({
        KeyId: aws(1),
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        EncryptionContext: {
          axiomDispatchPurpose: 'axiom.assessment.dispatch.dek.v1',
          axiomDispatchContext: dispatchKmsBinding(aad).digest,
        },
      });
    },
  );
  it.each([
    'name',
    'version',
    'checksum',
    'missing-checksum',
    'plaintext-unverified',
    'aad-unverified',
    'base64',
    'oversize',
  ])('refuses invalid GCP wrapping response (%s)', async (fault) => {
    const ciphertext = randomBytes(fault === 'oversize' ? 16385 : 80);
    const encrypt = vi.fn<DispatchGcpKmsPort['encrypt']>().mockResolvedValue([
      {
        name:
          (fault === 'name' ? gcp(9) : gcp(1)) +
          '/cryptoKeyVersions/' +
          (fault === 'version' ? '0' : '1'),
        ciphertext: fault === 'base64' ? '***' : ciphertext,
        ciphertextCrc32c:
          fault === 'missing-checksum'
            ? null
            : { value: crc32c(ciphertext) + (fault === 'checksum' ? 1 : 0) },
        verifiedPlaintextCrc32c: fault !== 'plaintext-unverified',
        verifiedAdditionalAuthenticatedDataCrc32c: fault !== 'aad-unverified',
      },
    ]);
    await expect(
      new GcpDispatchKeyWrapper(policy('gcp'), { encrypt, decrypt: vi.fn() }).wrap(
        aad,
        randomBytes(32),
      ),
    ).rejects.toThrow();
    expect(encrypt.mock.calls[0]?.[1]).toEqual({ timeout: 5000, retry: null });
    expect((encrypt.mock.calls[0]?.[0].plaintext as Uint8Array).every((v) => v === 0)).toBe(true);
  });
  it.each(['success', 'base64-success', 'checksum', 'missing-checksum', 'size', 'base64'])(
    'checks GCP plaintext and clears provider bytes (%s)',
    async (fault) => {
      const plaintext = randomBytes(fault === 'size' ? 31 : 32),
        expected = Buffer.from(plaintext);
      const decrypt = vi.fn<DispatchGcpKmsPort['decrypt']>().mockResolvedValue([
        {
          plaintext:
            fault === 'base64'
              ? expected.toString('base64') + '\n'
              : fault === 'base64-success'
                ? expected.toString('base64')
                : plaintext,
          plaintextCrc32c:
            fault === 'missing-checksum'
              ? null
              : { value: crc32c(plaintext) + (fault === 'checksum' ? 1 : 0) },
        },
      ]);
      const call = new GcpDispatchKeyWrapper(policy('gcp'), { encrypt: vi.fn(), decrypt }).unwrap(
        aad,
        gcp(1),
        randomBytes(80),
      );
      if (fault.endsWith('success')) expect(await call).toEqual(expected);
      else await expect(call).rejects.toThrow();
      if (!fault.startsWith('base64')) expect(plaintext.every((v) => v === 0)).toBe(true);
      const args = decrypt.mock.calls[0]![0];
      expect(args.additionalAuthenticatedData).toEqual(dispatchKmsBinding(aad).aad);
      expect(args.additionalAuthenticatedDataCrc32c).toEqual({
        value: crc32c(dispatchKmsBinding(aad).aad),
      });
      expect(args.ciphertextCrc32c).toEqual({ value: crc32c(args.ciphertext as Uint8Array) });
    },
  );
  it.each(['aws', 'gcp'] as const)(
    'bounds %s calls, keeps the slot until settlement and clears late plaintext',
    async (provider) => {
      vi.useFakeTimers();
      let finish!: (plaintext: Buffer) => void;
      const pending = new Promise<Buffer>((resolve) => {
        finish = resolve;
      });
      const send = vi.fn<DispatchAwsKmsPort['send']>(async () => ({
        KeyId: aws(1),
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: await pending,
      }));
      const decrypt = vi.fn<DispatchGcpKmsPort['decrypt']>(async () => [
        { plaintext: await pending },
      ]);
      const wrapper =
        provider === 'aws'
          ? new AwsDispatchKeyWrapper(policy(provider), { send })
          : new GcpDispatchKeyWrapper(policy(provider), { encrypt: vi.fn(), decrypt });
      const ref = policy(provider).primary(tenant);
      const assertion = expect(wrapper.unwrap(aad, ref, randomBytes(80))).rejects.toThrow(
        'Private assessment dispatch was refused.',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      await expect(wrapper.unwrap(aad, ref, randomBytes(80))).rejects.toThrow();
      expect(provider === 'aws' ? send : decrypt).toHaveBeenCalledTimes(1);
      if (provider === 'aws') expect(send.mock.calls[0]?.[1].abortSignal.aborted).toBe(true);
      const late = randomBytes(32);
      finish(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.every((v) => v === 0)).toBe(true);
    },
  );
  it.each(['aws', 'gcp'] as const)(
    'sanitizes %s credential/provider errors without a cause',
    async (provider) => {
      const fail = async (): Promise<never> => {
        throw new Error('secret-provider-detail');
      };
      const wrapper =
        provider === 'aws'
          ? new AwsDispatchKeyWrapper(policy(provider), { send: fail })
          : new GcpDispatchKeyWrapper(policy(provider), { encrypt: fail, decrypt: fail });
      for (const operation of [
        () => wrapper.wrap(aad, randomBytes(32)),
        () => wrapper.unwrap(aad, policy(provider).primary(tenant), randomBytes(80)),
      ]) {
        const error = await operation().catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toBe('DispatchRefused: Private assessment dispatch was refused.');
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );
  it.each(['aws', 'gcp'] as const)(
    'clears the copied %s wrapping input on deadline',
    async (provider) => {
      vi.useFakeTimers();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const send = vi.fn<DispatchAwsKmsPort['send']>(async () => {
        await pending;
        return {};
      });
      const encrypt = vi.fn<DispatchGcpKmsPort['encrypt']>(async () => {
        await pending;
        return [{}];
      });
      const key = randomBytes(32),
        original = Buffer.from(key);
      const wrapper =
        provider === 'aws'
          ? new AwsDispatchKeyWrapper(policy(provider), { send })
          : new GcpDispatchKeyWrapper(policy(provider), { encrypt, decrypt: vi.fn() });
      const assertion = expect(wrapper.wrap(aad, key)).rejects.toThrow(
        'Private assessment dispatch was refused.',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      const sdkInput =
        provider === 'aws'
          ? (send.mock.calls[0]![0] as EncryptCommand).input.Plaintext!
          : (encrypt.mock.calls[0]![0].plaintext as Uint8Array);
      expect(sdkInput.every((value) => value === 0)).toBe(true);
      expect(key).toEqual(original);
      await expect(wrapper.wrap(aad, key)).rejects.toThrow();
      expect(provider === 'aws' ? send : encrypt).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
    },
  );
});
