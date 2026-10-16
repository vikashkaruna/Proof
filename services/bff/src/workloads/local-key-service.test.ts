import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, chmod, rm, readdir, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalKeyPolicy, type LocalKeyAdmissionRequest } from './local-key-policy.js';
import { LocalKeyService } from './local-key-service.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  revision = '22222222-2222-4222-8222-222222222222';
const workload = '33333333-3333-4333-8333-333333333333';
const ref = `axiom-local-dispatch://${tenant}/${revision}/versions/1`,
  next = ref.replace(/versions\/1$/, 'versions/2');
const policy = new LocalKeyPolicy({
  tenantId: tenant,
  revision,
  mode: 'local_demo',
  validity: { kind: 'fixed_expiry', expiresAt: Date.now() + 600000 },
  primary: ref,
  readable: [ref, next],
});
const caller = (role: 'operator' | 'producer' | 'controller') => ({
  tenantId: tenant,
  workloadId: workload,
  role,
});
const context = dispatchWrappingContext({
  tenantId: tenant,
  jobId: revision,
  actorId: workload,
  workloadId: workload,
  estateId: null,
  engagementId: revision,
  correlationId: workload,
  inputHash: 'a'.repeat(64),
});
function admission(r: LocalKeyAdmissionRequest) {
  const { deadline: _d, ...binding } = r;
  return {
    ...binding,
    verified: true,
    expiresAt: Date.now() + 10000,
    revoked: false,
    isDemo: true,
    operatorActivated: true,
    admissionReceiptId: revision,
    exception: null,
  };
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), 'axiom-local-key-'));
  await chmod(directory, 0o700);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('persistent local key custody', () => {
  it('persists tenant/version-separated keys and roundtrips across service restart, with immutable old versions', async () => {
    const service = new LocalKeyService(directory, policy, async (r) => admission(r));
    await service.provision(caller('operator'), ref);
    await service.provision(caller('operator'), next);
    await expect(service.provision(caller('operator'), ref)).rejects.toThrow();
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const f of files) expect((await stat(join(directory, f))).mode & 0o777).toBe(0o600);
    const plain = Buffer.alloc(32, 7),
      wrapped = await service.wrap(caller('producer'), context, plain);
    expect(wrapped.keyRef).toBe(ref);
    expect(Buffer.from(wrapped.wrappedKey).includes(plain)).toBe(false);
    const restarted = new LocalKeyService(directory, policy, async (r) => admission(r));
    expect(await restarted.unwrap(caller('controller'), context, ref, wrapped.wrappedKey)).toEqual(
      plain,
    );
    const promoted = new LocalKeyPolicy({
      ...policy.value,
      revision: workload,
      primary: next,
      readable: [ref, next],
    });
    const rotated = new LocalKeyService(directory, promoted, async (r) => admission(r));
    expect((await rotated.wrap(caller('producer'), context, plain)).keyRef).toBe(next);
    expect(await rotated.unwrap(caller('controller'), context, ref, wrapped.wrappedKey)).toEqual(
      plain,
    );

    const altered = Buffer.from(wrapped.wrappedKey);
    altered[35] = altered[35]! ^ 1;
    await expect(restarted.unwrap(caller('controller'), context, ref, altered)).rejects.toThrow();
    const other = Buffer.from(context.toString().replace('a'.repeat(64), 'b'.repeat(64)));
    await expect(
      restarted.unwrap(caller('controller'), other, ref, wrapped.wrappedKey),
    ).rejects.toThrow();
    await expect(
      restarted.unwrap(caller('controller'), context, next, wrapped.wrappedKey),
    ).rejects.toThrow();
  });
  it('refuses before filesystem IO when no authority exists and sanitizes errors', async () => {
    const service = new LocalKeyService('/does/not/exist/secret', policy);
    await expect(service.provision(caller('operator'), ref)).rejects.toThrow(
      'Private assessment dispatch was refused.',
    );
    await expect(service.wrap(caller('controller'), context, Buffer.alloc(32))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it('rechecks after IO and never releases plaintext after revocation', async () => {
    const stable = new LocalKeyService(directory, policy, async (r) => admission(r));
    await stable.provision(caller('operator'), ref);
    const wrapped = await stable.wrap(caller('producer'), context, Buffer.alloc(32, 9));
    let n = 0;
    const revoked = new LocalKeyService(directory, policy, async (r) => ({
      ...admission(r),
      revoked: ++n > 1,
    }));
    await expect(
      revoked.unwrap(caller('controller'), context, ref, wrapped.wrappedKey),
    ).rejects.toThrow();
    expect(n).toBe(2);
  });
  it('refuses symlink directories, unsafe file modes and foreign role/tenant', async () => {
    const s = new LocalKeyService(directory, policy, async (r) => admission(r));
    await s.provision(caller('operator'), ref);
    const [f] = await readdir(directory);
    await chmod(join(directory, f!), 0o644);
    await expect(s.wrap(caller('producer'), context, Buffer.alloc(32))).rejects.toThrow();
    await expect(
      s.wrap({ ...caller('producer'), tenantId: revision }, context, Buffer.alloc(32)),
    ).rejects.toThrow();
    const linked = directory + '-link';
    await symlink(directory, linked);
    try {
      await expect(
        new LocalKeyService(linked, policy, async (r) => admission(r)).provision(
          caller('operator'),
          next,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(linked);
    }
  });
});
