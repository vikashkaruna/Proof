import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withOwnedTargetCredential, type OwnedTargetScope } from './owned-target-credentials.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'axiom-owned-credential-')));
  dirs.push(dir);
  await chmod(dir, 0o700);
  const filename = join(dir, 'target.private.json');
  const now = Math.floor(Date.now() / 1000);
  const scope: OwnedTargetScope = {
    tenantId: id(1),
    bindingId: id(2),
    enrollmentId: id(3),
    credentialId: id(4),
    custodyEpoch: 2,
    expiresAt: new Date((now + 600) * 1000).toISOString(),
  };
  const claims: Record<string, unknown> = {
    role: 'owned_target_controller',
    owned_target_purpose: 'owned_synthetic_target_v1',
    tenant_id: id(1),
    binding_id: id(2),
    enrollment_id: id(3),
    jti: id(4),
    custody_epoch: 2,
    iat: now,
    exp: now + 600,
  };
  const token = (raw = JSON.stringify(claims)) =>
    `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(raw).toString('base64url')}.${'a'.repeat(43)}`;
  const data = () => JSON.stringify({ ...scope, schemaVersion: 1, accessToken: token() });
  const write = async (raw = data()) => {
    await writeFile(filename, raw, { mode: 0o600 });
    return createHash('sha256').update(raw).digest('hex');
  };
  return { dir, filename, scope, claims, token, write, data };
}
it('selects exact protected binding credential without exposing it to environment', async () => {
  const f = await fixture(),
    digest = await f.write(),
    use = vi.fn(async (key: string) => key === f.token());
  const before = { ...process.env };
  expect(await withOwnedTargetCredential(f.filename, digest, f.scope, use)).toBe(true);
  expect(use).toHaveBeenCalledOnce();
  expect(process.env).toEqual(before);
});
it.each([
  'tenant_id',
  'binding_id',
  'enrollment_id',
  'jti',
  'custody_epoch',
  'role',
  'owned_target_purpose',
  'exp',
  'iat',
  'nbf',
])('refuses foreign/invalid signed claim %s before transport', async (field) => {
  const f = await fixture();
  f.claims[field] =
    field === 'custody_epoch'
      ? 3
      : field === 'exp'
        ? 1
        : field === 'iat' || field === 'nbf'
          ? Math.floor(Date.now() / 1000) + 500
          : id(9);
  const use = vi.fn();
  const digest = await f.write();
  await expect(withOwnedTargetCredential(f.filename, digest, f.scope, use)).rejects.toThrow(
    'Owned target credential refused',
  );
  expect(use).not.toHaveBeenCalled();
});
it('refuses expired scope and excessive lifetime even if file and claims agree', async () => {
  const f = await fixture();
  f.scope.expiresAt = new Date((Number(f.claims.iat) + 901) * 1000).toISOString();
  f.claims.exp = Number(f.claims.iat) + 901;
  const digest = await f.write();
  await expect(withOwnedTargetCredential(f.filename, digest, f.scope, vi.fn())).rejects.toThrow(
    'Owned target credential refused',
  );
});
it('refuses replaced bytes, duplicate escaped JSON, or token claims with duplicate keys', async () => {
  const f = await fixture(),
    digest = await f.write();
  await f.write(f.data() + ' ');
  await expect(withOwnedTargetCredential(f.filename, digest, f.scope, vi.fn())).rejects.toThrow(
    'Owned target credential refused',
  );
  for (const raw of [
    f.data().replace('{', '{"tenant\\u0049d":"' + id(9) + '",'),
    JSON.stringify({
      ...f.scope,
      schemaVersion: 1,
      accessToken: f.token(JSON.stringify(f.claims).replace('{', '{"tenant_id":"' + id(9) + '",')),
    }),
  ]) {
    const hash = await f.write(raw);
    await expect(withOwnedTargetCredential(f.filename, hash, f.scope, vi.fn())).rejects.toThrow(
      'Owned target credential refused',
    );
  }
});
it('refuses readable files, writable parent and symlink files', async () => {
  const f = await fixture(),
    digest = await f.write();
  await chmod(f.filename, 0o644);
  await expect(withOwnedTargetCredential(f.filename, digest, f.scope, vi.fn())).rejects.toThrow(
    'Owned target credential refused',
  );
  await chmod(f.filename, 0o600);
  await chmod(f.dir, 0o777);
  await expect(withOwnedTargetCredential(f.filename, digest, f.scope, vi.fn())).rejects.toThrow(
    'Owned target credential refused',
  );
  await chmod(f.dir, 0o700);
  const link = join(f.dir, 'link');
  await symlink(f.filename, link);
  await expect(withOwnedTargetCredential(link, digest, f.scope, vi.fn())).rejects.toThrow(
    'Owned target credential refused',
  );
});
