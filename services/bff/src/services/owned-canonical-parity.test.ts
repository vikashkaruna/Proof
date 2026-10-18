import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ownedHash, ownedPlanRequestSchema, ownedRoundtripSchema } from './owned-execution-plan.js';

it('pins real request and roundtrip schemas to the native SQL canonical hash vectors', () => {
  const vector = JSON.parse(
    readFileSync(
      new URL(
        '../../../../tests/database/fixtures/owned-human-canonical-vectors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const request = ownedPlanRequestSchema.parse(vector.request);
  const proof = ownedRoundtripSchema.parse(vector.proof);
  expect(ownedHash(proof.before)).toBe(vector.snapshotHash);
  expect(request.expectedSnapshotHash).toBe(vector.snapshotHash);
  expect(ownedHash({ tenantId: vector.tenantId, actorId: vector.actorId, request })).toBe(
    vector.requestHash,
  );
  expect(ownedHash(proof)).toBe(vector.proofHash);
});
