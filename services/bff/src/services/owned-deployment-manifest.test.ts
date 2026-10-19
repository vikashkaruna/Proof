import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ownedDeploymentManifest,
  ownedDeploymentManifestSha256,
  readOwnedDeploymentManifests,
} from './owned-deployment-manifest.js';
import { makeOwnedDeploymentManifest as manifest } from '../test/owned-deployment-fixture.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function file(raw: unknown) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'axiom-owned-manifest-')));
  dirs.push(dir);
  await chmod(dir, 0o700);
  const path = join(dir, 'registry.private.json');
  await writeFile(path, typeof raw === 'string' ? raw : JSON.stringify(raw), { mode: 0o600 });
  return path;
}
it('loads only the exact reviewed protected synthetic manifest keyed by canonical digest', async () => {
  const m = manifest(),
    filename = await file({ schemaVersion: 1, manifests: [m] });
  expect(
    (await readOwnedDeploymentManifests(filename)).get(ownedDeploymentManifestSha256(m)),
  ).toEqual(m);
  expect(ownedDeploymentManifestSha256({ ...m, custodyEpoch: 2 })).not.toEqual(
    ownedDeploymentManifestSha256(m),
  );
});
it.each(['environment', 'scope', 'source', 'deployment', 'rollback', 'bindingId'])(
  'refuses widening fixed manifest %s',
  (field) => {
    const m = manifest();
    const bad: unknown = {
      ...m,
      [field]:
        field === 'bindingId'
          ? m.resourceId
          : field === 'environment'
            ? 'production'
            : field === 'deployment'
              ? { ...m.deployment, workerUid: 0 }
              : field === 'rollback'
                ? { ...m.rollback, deleteAuditOrEvidence: true }
                : 'arbitrary',
    };
    expect(ownedDeploymentManifest.safeParse(bad).success).toBe(false);
  },
);
it('refuses future, expired, duplicated identities and duplicate JSON keys', async () => {
  for (const m of [
    { ...manifest(), reviewedAt: new Date(Date.now() + 1000).toISOString() },
    { ...manifest(), expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const filename = await file({ schemaVersion: 1, manifests: [m] });
    await expect(readOwnedDeploymentManifests(filename)).rejects.toThrow(
      'Owned deployment manifest unavailable',
    );
  }
  const m = manifest();
  for (const raw of [
    { schemaVersion: 1, manifests: [m, m] },
    { schemaVersion: 1, manifests: [m, { ...m, custodyEpoch: 2 }] },
  ]) {
    await expect(readOwnedDeploymentManifests(await file(raw))).rejects.toThrow(
      'Owned deployment manifest unavailable',
    );
  }
  const raw = JSON.stringify({ schemaVersion: 1, manifests: [m] }).replace(
    '{',
    '{"schema\\u0056ersion":9,',
  );
  await expect(readOwnedDeploymentManifests(await file(raw))).rejects.toThrow(
    'Owned deployment manifest unavailable',
  );
});
it('refuses writable configuration files and ancestor directories', async () => {
  const filename = await file({ schemaVersion: 1, manifests: [manifest()] });
  await chmod(filename, 0o644);
  await expect(readOwnedDeploymentManifests(filename)).rejects.toThrow(
    'Owned deployment manifest unavailable',
  );
  await chmod(filename, 0o600);
  await chmod(join(filename, '..'), 0o777);
  await expect(readOwnedDeploymentManifests(filename)).rejects.toThrow(
    'Owned deployment manifest unavailable',
  );
});
