import { describe, expect, it } from 'vitest';
import {
  PRATIVEDAN_INPUT_MAX_BYTES,
  prativedanDraftRequestSchema,
  prativedanDraftOutputSchema,
  prativedanFrozenSourceSchema,
  prativedanSourceWitnessSchema,
  prativedanRendererInputSchema,
  prativedanRuntimeEnvelopeSchema,
  prativedanReceiptWitnessSchema,
  prativedanDraftReadbackProofSchema,
  prativedanLedgerReceiptSchema,
  prativedanRecordedDispatchSchema,
  prativedanDispatchClaimSchema,
} from './prativedan-drafts';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  prativedanRendererConfigSchema,
} from './prativedan-renderer-config';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (letter: string) => letter.repeat(64);
const receipt = (n: number) => ({ id: String(n), entry_hash: hash('a') });
const request = () => ({
  operationKey: id(1),
  engagementId: id(2),
  assessmentRunId: id(3),
  expectedSourceSha256: hash('a'),
  sourceReviewed: true as const,
});
const source = () => ({
  schema_version: 1 as const,
  serialization: 'postgres-jsonb-text-v1' as const,
  kind: 'board_source' as const,
  request_id: id(4),
  tenant_id: id(5),
  engagement_id: id(2),
  assessment_run_id: id(3),
  library_version: '0.1.1',
  controls_text: '[{"id":"C1"}]',
  controls_sha256: hash('b'),
  result_text: '{"posture_score":null}',
  result_sha256: hash('c'),
  completed_at: '2026-10-05T10:00:00+00:00',
  finalized_at: '2026-10-05T10:01:00+00:00',
  receipts: { started: receipt(1), completed: receipt(2), finalized: receipt(3) },
  limitations: ['No independent evidence verification.'],
});
const finding = () => ({
  control_id: 'C1',
  title: 'Synthetic control',
  severity: 'info' as const,
  score: null,
  rationale: 'Unverified declaration.',
});
const input = () => ({
  tenant_id: id(5),
  engagement_id: id(2),
  kind: 'board' as const,
  title: 'Unpublished draft',
  findings: [finding()],
  posture_score: null,
  estimated_exposure_inr: null,
  library_version: '0.1.1',
  library_control_ids: ['C1'],
  reviewer_id: null,
});
const output = () => ({
  title: 'Unpublished draft',
  kind: 'board' as const,
  sections: [
    { type: 'executive_summary', title: 'Executive summary', body: 'Unknown posture.' },
    { type: 'findings_table', title: 'Findings', items: [{ ...finding(), risk_points: null }] },
    { type: 'library', title: 'Library', body: 'Source controls.' },
    { type: 'attribution', title: 'Draft attribution', body: 'Pending human review.' },
  ],
  cited_evidence_ids: [],
  generated_by_agent: 'prativedan' as const,
  rendered_html: '<h1>Unpublished draft</h1>',
  review_required: true as const,
  citation_verification: 'unverified_references' as const,
});
const bindings = () => ({
  renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
  renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
  tenant_id: id(5),
  engagement_id: id(2),
  source_id: id(4),
  assessment_run_id: id(3),
  run_id: id(6),
  operation_key: id(1),
  source_sha256: hash('a'),
  request_sha256: hash('b'),
  runtime_normalized_input_sha256: hash('c'),
  runtime_output_sha256: hash('d'),
  agent: 'prativedan' as const,
  agent_version: '0.1.0',
  correlation_id: id(7),
  target_ref: `prativedan-draft:${id(6)}`,
  requested_receipt: receipt(4),
  started_receipt: receipt(5),
  completed_receipt: receipt(6),
});
const envelope = () => ({
  ...bindings(),
  renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
  normalized_input_text: JSON.stringify(input()),
  runtime_output_text: JSON.stringify(output()),
  output: output(),
  review_required: true as const,
  citation_verification: 'unverified_references' as const,
});
const proof = () => ({
  ...bindings(),
  renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
  kind: 'prativedan_unpublished_draft' as const,
  schema_version: 1 as const,
  draft_id: id(8),
  actor_id: id(9),
  request: request(),
  request_text: JSON.stringify(request()),
  normalized_input_text: JSON.stringify(input()),
  runtime_output_text: JSON.stringify(output()),
  response_output_sha256: hash('e'),
  settled_receipt: receipt(7),
  state: 'unpublished' as const,
  publication_allowed: false as const,
  review_required: true as const,
  citation_verification: 'unverified_references' as const,
  output: output(),
});

describe('Prativedan unpublished trust contracts', () => {
  it('requires a versioned actual renderer manifest with explicit absence of model inference', () => {
    const manifest = JSON.parse(PRATIVEDAN_RENDERER_CONFIG_TEXT);
    expect(prativedanRendererConfigSchema.parse(manifest).model_inference).toBe(false);
    expect(prativedanRendererConfigSchema.parse(manifest).model_identity).toBeNull();
    for (const changed of [
      { ...manifest, model_inference: true },
      { ...manifest, model_identity: 'claimed-model' },
      { ...manifest, finding_limit: 20 },
      { ...manifest, renderer_config_version: 'caller-version' },
    ])
      expect(prativedanRendererConfigSchema.safeParse(changed).success).toBe(false);
    for (const key of [
      'renderer_config_version',
      'renderer_config_sha256',
      'renderer_config_text',
    ]) {
      const changed: Record<string, unknown> = { ...envelope() };
      delete changed[key];
      expect(prativedanRuntimeEnvelopeSchema.safeParse(changed).success).toBe(false);
      const retained: Record<string, unknown> = { ...proof() };
      delete retained[key];
      expect(prativedanDraftReadbackProofSchema.safeParse(retained).success).toBe(false);
    }
  });
  it('binds retained request and exclusive claim to a separate configuration identity', () => {
    const {
      tenant_id,
      engagement_id,
      source_id,
      assessment_run_id,
      run_id,
      operation_key,
      renderer_config_version,
      renderer_config_sha256,
    } = bindings();
    const identity = {
      tenant_id,
      engagement_id,
      source_id,
      assessment_run_id,
      run_id,
      operation_key,
      renderer_config_version,
      renderer_config_sha256,
    };
    const dispatch = {
      ...identity,
      request_text: JSON.stringify(request()),
      request_sha256: hash('b'),
      source_sha256: hash('a'),
      requested_receipt: receipt(4),
    };
    const claim = {
      ...identity,
      request_sha256: hash('b'),
      source_sha256: hash('a'),
      runtime_normalized_input_sha256: hash('c'),
      claimed: true,
      expires_at_ms: 2000,
    };
    expect(prativedanRecordedDispatchSchema.safeParse(dispatch).success).toBe(true);
    expect(prativedanDispatchClaimSchema.safeParse(claim).success).toBe(true);
    expect(prativedanDispatchClaimSchema.safeParse({ ...claim, claimed: false }).success).toBe(
      false,
    );
    for (const key of ['renderer_config_version', 'renderer_config_sha256']) {
      const missingDispatch: Record<string, unknown> = { ...dispatch };
      delete missingDispatch[key];
      expect(prativedanRecordedDispatchSchema.safeParse(missingDispatch).success).toBe(false);
      const missingClaim: Record<string, unknown> = { ...claim };
      delete missingClaim[key];
      expect(prativedanDispatchClaimSchema.safeParse(missingClaim).success).toBe(false);
    }
  });
  it('accepts only the explicit IDs-only source-review request', () => {
    expect(prativedanDraftRequestSchema.parse(request())).toEqual(request());
    for (const extra of [
      { findings: [] },
      { reviewerId: id(9) },
      { tenantId: id(5) },
      { title: 'Caller prose' },
    ])
      expect(prativedanDraftRequestSchema.safeParse({ ...request(), ...extra }).success).toBe(
        false,
      );
    expect(
      prativedanDraftRequestSchema.safeParse({ ...request(), sourceReviewed: false }).success,
    ).toBe(false);
  });
  it.each(['', 'a'.repeat(63), 'A'.repeat(64), 'f'.repeat(65)])(
    'rejects malformed source hash %s',
    (digest) => {
      expect(
        prativedanDraftRequestSchema.safeParse({ ...request(), expectedSourceSha256: digest })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    'not-an-id',
    '00000000-0000-1000-8000-000000000001',
    'AB000000-0000-4000-8000-000000000001',
  ])('rejects malformed/noncanonical ID %s', (value) => {
    expect(
      prativedanDraftRequestSchema.safeParse({ ...request(), operationKey: value }).success,
    ).toBe(false);
  });
  it('retains raw PostgreSQL strings and actual board source identity without relabeling', () => {
    const frozen = source();
    frozen.controls_text = '[ { "id" : "C1" } ]';
    expect(prativedanFrozenSourceSchema.parse(frozen).controls_text).toBe(frozen.controls_text);
    expect(
      prativedanFrozenSourceSchema.safeParse({ ...frozen, kind: 'prativedan_source' }).success,
    ).toBe(false);
    const witness = {
      source_id: frozen.request_id,
      tenant_id: frozen.tenant_id,
      engagement_id: frozen.engagement_id,
      assessment_run_id: frozen.assessment_run_id,
      library_version: frozen.library_version,
      title: 'Unpublished draft',
      source_text: JSON.stringify(frozen),
      source_sha256: hash('a'),
      controls_sha256: hash('b'),
      result_sha256: hash('c'),
      receipts: frozen.receipts,
    };
    expect(prativedanSourceWitnessSchema.parse(witness).source_text).toBe(witness.source_text);
  });
  it('refuses unordered assessment receipts and impossible finalization chronology', () => {
    const frozen = source();
    frozen.receipts.finalized = receipt(2);
    expect(prativedanFrozenSourceSchema.safeParse(frozen).success).toBe(false);
    expect(
      prativedanFrozenSourceSchema.safeParse({ ...source(), finalized_at: '2026-10-05T09:00:00Z' })
        .success,
    ).toBe(false);
  });
  it.each(['0', '00', '-1', 'abc', '9223372036854775808'])(
    'refuses invalid PG receipt %s without throwing',
    (value) => {
      expect(
        prativedanLedgerReceiptSchema.safeParse({ id: value, entry_hash: hash('a') }).success,
      ).toBe(false);
      expect(
        prativedanReceiptWitnessSchema.safeParse({
          ...bindings(),
          started_receipt: { id: value, entry_hash: hash('a') },
        }).success,
      ).toBe(false);
    },
  );
  it('requires all Python defaults explicitly and retains unknown metrics', () => {
    expect(prativedanRendererInputSchema.parse(input())).toEqual(input());
    for (const key of [
      'posture_score',
      'estimated_exposure_inr',
      'reviewer_id',
      'kind',
      'library_control_ids',
    ]) {
      const changed: Record<string, unknown> = { ...input() };
      delete changed[key];
      expect(prativedanRendererInputSchema.safeParse(changed).success).toBe(false);
    }
    expect(
      prativedanRendererInputSchema.safeParse({ ...input(), posture_score: NaN }).success,
    ).toBe(false);
    expect(
      prativedanRendererInputSchema.safeParse({
        ...input(),
        estimated_exposure_inr: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      prativedanRendererInputSchema.safeParse({ ...input(), reviewer_id: id(9) }).success,
    ).toBe(false);
  });
  it('requires exactly the complete distinct pinned control set and refuses caller evidence', () => {
    const original = input();
    for (const changed of [
      { ...original, library_control_ids: ['C1', 'C1'] },
      { ...original, library_control_ids: ['C1', 'C2'] },
      { ...original, findings: [finding(), finding()] },
      { ...original, findings: [{ ...finding(), control_id: 'foreign' }] },
      { ...original, findings: [{ ...finding(), evidence_ids: [id(8)] }] },
    ])
      expect(prativedanRendererInputSchema.safeParse(changed).success).toBe(false);
  });
  it('bounds UTF-8 payload bytes and refuses NUL/unpaired surrogates', () => {
    for (const title of ['bad\0title', '\ud800', 'अ'.repeat(101)])
      expect(prativedanRendererInputSchema.safeParse({ ...input(), title }).success).toBe(false);
    const changed = input();
    changed.findings = Array.from({ length: 100 }, (_, index) => ({
      ...finding(),
      control_id: `C${index}`,
      rationale: 'x'.repeat(15000),
    }));
    changed.library_control_ids = changed.findings.map((row) => row.control_id);
    expect(JSON.stringify(changed).length).toBeGreaterThan(PRATIVEDAN_INPUT_MAX_BYTES);
    expect(prativedanRendererInputSchema.safeParse(changed).success).toBe(false);
  });
  it('accepts honest output but refuses publication/review claims, citation claims and section additions', () => {
    expect(prativedanDraftOutputSchema.safeParse(output()).success).toBe(true);
    for (const changed of [
      { ...output(), review_required: false },
      { ...output(), citation_verification: 'verified' },
      { ...output(), cited_evidence_ids: [id(8)] },
      { ...output(), approved_by: id(9) },
      { ...output(), sections: [...output().sections, { type: 'legal_signoff' }] },
    ])
      expect(prativedanDraftOutputSchema.safeParse(changed).success).toBe(false);
  });
  it('keeps runtime and response hash domains independent without numeric codec equality', () => {
    const runtime = envelope();
    expect(prativedanRuntimeEnvelopeSchema.safeParse(runtime).success).toBe(true);
    expect(prativedanReceiptWitnessSchema.safeParse(bindings()).success).toBe(true);
    const retained = prativedanDraftReadbackProofSchema.parse(proof());
    expect(
      new Set([
        retained.source_sha256,
        retained.request_sha256,
        retained.runtime_normalized_input_sha256,
        retained.runtime_output_sha256,
        retained.response_output_sha256,
      ]).size,
    ).toBe(5);
    // Both codecs may represent the same numeric value differently; helpers
    // verify exact bytes against independent receipts, never equality of domains.
    const numericOutput = prativedanDraftOutputSchema.parse(output());
    numericOutput.sections[1].items[0]!.score = 1e-7;
    const numericRuntime = {
      ...runtime,
      output: numericOutput,
      runtime_output_text: JSON.stringify(numericOutput).replace('1e-7', '1e-07'),
    };
    expect(prativedanRuntimeEnvelopeSchema.safeParse(numericRuntime).success).toBe(true);
  });
  it('binds original source-reviewed request and settlement order on readback', () => {
    for (const key of ['normalized_input_text', 'runtime_output_text']) {
      const hashOnly: Record<string, unknown> = { ...proof() };
      delete hashOnly[key];
      expect(prativedanDraftReadbackProofSchema.safeParse(hashOnly).success).toBe(false);
    }
    for (const changed of [
      { ...proof(), operation_key: id(11) },
      { ...proof(), engagement_id: id(11) },
      { ...proof(), source_sha256: hash('f') },
      { ...proof(), assessment_run_id: id(11) },
      { ...proof(), settled_receipt: receipt(6) },
      { ...proof(), publication_allowed: true },
      { ...proof(), state: 'published' },
    ])
      expect(prativedanDraftReadbackProofSchema.safeParse(changed).success).toBe(false);
  });
});
