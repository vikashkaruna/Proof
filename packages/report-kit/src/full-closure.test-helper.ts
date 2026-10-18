/** Synthetic bytes only. This fixture never claims provider acceptance. */
import { createHash } from 'node:crypto';
import type { FullClosureComponent } from './full-closure.js';
export const fullClosureSha = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const id = (n: number) => `16400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function fullClosureFixture() {
  const tenantId = id(1),
    engagementId = id(2),
    reportId = id(3);
  const kinds = [
    'board_executive',
    'auditor_assurance',
    'technical_register',
    'approval_proof',
    'evidence',
  ] as const;
  const members = kinds.map((kind, i) => ({
    id: id(i + 10),
    bytes: Buffer.from(`Synthetic ${kind}`),
  }));
  const components: FullClosureComponent[] = kinds.map((kind, i) => ({
    id: members[i]!.id,
    kind,
    tenant_id: tenantId,
    engagement_id: engagementId,
    provider_engagement_id: kind === 'approval_proof' ? null : engagementId,
    legal_hold: false,
    operation_id: id(i + 20),
    provider: 's3-compatible',
    bucket: 'axiom-proof-local-evidence',
    object_key: `synthetic/${kind}`,
    version_id: `version-${i}`,
    content_hash: fullClosureSha(members[i]!.bytes),
    byte_size: members[i]!.bytes.length,
    retain_until: '2034-01-01T00:00:00.000Z',
    encryption: 'AES256',
    collected_by_agent:
      kind === 'approval_proof'
        ? 'approval-proof-archive'
        : kind === 'evidence'
          ? 'human'
          : 'pramaan',
  }));
  const payload = [
    '1',
    id(4),
    'human',
    id(5),
    '',
    '',
    '',
    'closure.pramaan.sealed',
    id(6),
    '',
    '',
    '',
    '',
    '',
    '',
    'success',
    '2026-10-01 00:00:00+00',
    '',
    '{}',
  ].join('|');
  const hash = fullClosureSha(payload);
  const source = {
    schema_version: 1 as const,
    kind: 'full_closure_source' as const,
    tenant_id: tenantId,
    engagement_id: engagementId,
    board_report_id: reportId,
    assessment_run_id: id(7),
    library_version: '0.1.1',
    findings: [{ id: id(8), status: 'closed' as const }],
    plans: [{ id: id(9), status: 'completed' as const }],
    components,
    reconciliations: [
      {
        archive_id: id(30),
        plan_id: id(9),
        batch_id: id(31),
        source_sha256: components[3]!.content_hash,
        reconciliation: { statement: 'synthetic', signature: 'not-a-production-signature' },
      },
    ],
    ledger_chain: [
      { sequence_no: '1', payload_text: payload, entry_hash: hash, previous_hash: null },
    ],
    ledger_head: hash,
    as_of_sequence: '1',
    statutory_completeness_asserted: false as const,
    independent_audit_asserted: false as const,
  };
  const sourceText = JSON.stringify(source);
  return {
    tenantId,
    engagementId,
    reportId,
    title: 'Synthetic closure',
    source,
    sourceText,
    sourceSha256: fullClosureSha(sourceText),
    members,
  };
}
