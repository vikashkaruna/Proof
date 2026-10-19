import { createHash, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseDraftPreview } from './draft-view';
const id = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const receipt = (n: number) => ({ id: String(n), entry_hash: hash });
const source = {
  schema_version: 2,
  serialization: 'postgres-jsonb-text-v1',
  kind: 'prativedan_assessment_source',
  source_id: id,
  tenant_id: id,
  engagement_id: id,
  assessment_run_id: id,
  title: 'Synthetic',
  library_version: '0.1.1',
  controls_text: '[]',
  controls_sha256: hash,
  result_text: '{broken',
  result_sha256: hash,
  completed_at: '2026-10-19T00:00:00Z',
  finalized_at: '2026-10-19T00:01:00Z',
  receipts: { started: receipt(1), completed: receipt(2), finalized: receipt(3) },
  limitations: [
    'Recorded questionnaire computation; no independent evidence verification.',
    'Current remediation state is not included.',
    'Not a compliance certification or legal opinion.',
  ],
};
afterEach(() => vi.unstubAllGlobals());
it('rejects invalid nested result JSON before returning a renderable preview', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const text = JSON.stringify(source);
  await expect(
    parseDraftPreview(
      {
        source_text: text,
        source_sha256: createHash('sha256').update(text).digest('hex'),
        publication_allowed: false,
      },
      id,
      id,
      id,
    ),
  ).rejects.toThrow();
});
it('refuses a validly shaped foreign source before content rendering', async () => {
  const text = JSON.stringify({ ...source, tenant_id: '22222222-2222-4222-8222-222222222222' });
  await expect(
    parseDraftPreview(
      { source_text: text, source_sha256: hash, publication_allowed: false },
      id,
      id,
      id,
    ),
  ).rejects.toThrow(/another selection/);
});
