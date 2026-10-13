import { describe, expect, it } from 'vitest';
import {
  prativedanAssessmentSourceSchema as sourceSchema,
  prativedanAssessmentDraftRequestSchema as humanSchema,
  prativedanAssessmentRendererInputSchema as inputSchema,
  prativedanAssessmentPreviewSchema as previewSchema,
  prativedanAssessmentRequestAcknowledgementSchema as requestSchema,
  prativedanAssessmentReadbackSchema as readbackSchema,
  prativedanAssessmentClaimSchema as claimSchema,
  prativedanAssessmentSettlementSchema as settlementSchema,
  prativedanAssessmentReviewAcknowledgementSchema as reviewSchema,
} from './prativedan-assessment-drafts';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
} from './prativedan-renderer-config';
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = 'a'.repeat(64);
const receipt = (n: number) => ({ id: String(n), entry_hash: hash });
const expiry = '2026-10-13T12:05:00+00:00';
// Synthetic shape data only: these strings/hashes do not assert SQL execution,
// rendering fidelity, or real receipt custody.
const source = () => ({
  schema_version: 2,
  serialization: 'postgres-jsonb-text-v1',
  kind: 'prativedan_assessment_source',
  source_id: id(1),
  tenant_id: id(2),
  engagement_id: id(3),
  assessment_run_id: id(1),
  title: 'Assessment title',
  library_version: '0.1.1',
  controls_text: '[]',
  controls_sha256: hash,
  result_text: '{}',
  result_sha256: hash,
  completed_at: '2026-10-13T12:00:00+00:00',
  finalized_at: '2026-10-13T12:01:00Z',
  receipts: { started: receipt(1), completed: receipt(2), finalized: receipt(3) },
  limitations: [
    'Recorded questionnaire computation; no independent evidence verification.',
    'Current remediation state is not included.',
    'Not a compliance certification or legal opinion.',
  ],
});
const requested = () => ({
  schema_version: 2,
  kind: 'prativedan_unpublished_draft',
  tenant_id: id(2),
  operation_key: id(4),
  actor_id: id(5),
  source_id: id(1),
  assessment_run_id: id(1),
  engagement_id: id(3),
  run_id: id(6),
  source_text: '{}',
  source_sha256: hash,
  request_text: '{}',
  request_sha256: hash,
  renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
  renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
  renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
  requested_receipt: receipt(4),
  state: 'requested',
  publication_allowed: false,
  review_required: true,
  citation_verification: 'unverified_references',
});
const uncertain = () => ({
  ...requested(),
  state: 'invocation_uncertain',
  claimed_receipt: receipt(5),
  normalized_input_text: '{}',
  runtime_normalized_input_sha256: hash,
  claim_expires_at: expiry,
});
const output = () => ({
  title: 'Assessment title',
  kind: 'board',
  generated_by_agent: 'prativedan',
  cited_evidence_ids: [],
  rendered_html: '<h1>Draft</h1>',
  review_required: true,
  citation_verification: 'unverified_references',
  sections: [
    { type: 'executive_summary', title: 'Executive summary', body: 'Synthetic summary' },
    {
      type: 'findings_table',
      title: 'Findings for review (source order)',
      items: [
        {
          control_id: 'CTRL-1',
          title: 'Synthetic control',
          severity: 'low',
          score: 74,
          rationale: 'Synthetic rationale.',
          risk_points: null,
        },
      ],
    },
    { type: 'library', title: 'Control library', body: 'Synthetic library' },
    {
      type: 'attribution',
      title: 'Draft attribution and review status',
      body: 'Synthetic attribution',
    },
  ],
});
const unpublished = () => ({
  ...uncertain(),
  state: 'unpublished',
  draft_id: id(7),
  runtime_output_text: '{}',
  runtime_output_sha256: hash,
  response_output_text: '{}',
  response_output_sha256: hash,
  output: output(),
  started_receipt: receipt(6),
  completed_receipt: receipt(7),
  settled_receipt: receipt(8),
});
const review = () => ({
  actor_id: id(5),
  review_key: id(8),
  decision: 'accepted',
  reason: 'Reviewed synthetic draft only.',
  response_output_sha256: hash,
  receipt: receipt(9),
});

const human = () => ({
  operationKey: id(4),
  engagementId: id(3),
  assessmentRunId: id(1),
  expectedSourceSha256: hash,
  sourceReviewed: true,
});
const input = () => ({
  tenant_id: id(2),
  engagement_id: id(3),
  title: 'Synthetic assessment',
  kind: 'board',
  findings: [
    {
      control_id: 'CTRL-1',
      title: 'Synthetic control',
      severity: 'low',
      score: 74,
      rationale: 'Synthetic declaration; evidence unverified.',
    },
  ],
  posture_score: 74,
  estimated_exposure_inr: 10000000,
  library_version: '0.1.1',
  library_control_ids: ['CTRL-1'],
  reviewer_id: null,
});
describe('dedicated assessment draft SQL v2 shapes (unmounted)', () => {
  it.each([
    ['2026-10-13T12:00:00.000009Z', '2026-10-13T12:00:00.000001Z', false],
    ['2026-10-13T12:00:00.000000009Z', '2026-10-13T12:00:00.000000001Z', false],
    ['2026-10-13T17:30:00.000001+05:30', '2026-10-13T12:00:00.000009Z', true],
    ['2026-10-13T17:30:00.000009+05:30', '2026-10-13T12:00:00.000001Z', false],
    ['2026-10-13T07:00:00.123456789-05:00', '2026-10-13T12:00:00.123456789Z', true],
    ['2026-10-13T12:00:00.0000000001Z', '2026-10-13T12:01:00Z', false],
  ])('preserves source instant precision and offsets: %s / %s', (completed, finalized, valid) => {
    expect(
      sourceSchema.safeParse({ ...source(), completed_at: completed, finalized_at: finalized })
        .success,
    ).toBe(valid);
  });
  it.each(['é'.repeat(100), '😀'.repeat(100)])(
    'accepts 100 Unicode control characters within 400 UTF8 bytes',
    (controlId) => {
      expect(
        inputSchema.safeParse({
          ...input(),
          findings: [{ ...input().findings[0], control_id: controlId }],
          library_control_ids: [controlId],
        }).success,
      ).toBe(true);
    },
  );
  it('refuses more than 100 control characters even within the UTF8 bound', () => {
    const controlId = 'é'.repeat(101);
    expect(
      inputSchema.safeParse({
        ...input(),
        findings: [{ ...input().findings[0], control_id: controlId }],
        library_control_ids: [controlId],
      }).success,
    ).toBe(false);
  });
  it('accepts dedicated human request and complete renderer projection with SQL UUID semantics', () => {
    expect(humanSchema.safeParse(human()).success).toBe(true);
    expect(
      humanSchema.safeParse({ ...human(), assessmentRunId: '00000000-0000-0000-0000-000000000001' })
        .success,
    ).toBe(true);
    expect(inputSchema.safeParse(input()).success).toBe(true);
    expect(
      inputSchema.safeParse({
        ...input(),
        title: '😀'.repeat(300),
        findings: [{ ...input().findings[0], title: '😀'.repeat(300) }],
      }).success,
    ).toBe(true);
  });
  it('refuses human declarations without explicit review and caller findings', () => {
    for (const changed of [
      { sourceReviewed: false },
      { sourceReviewed: 'true' },
      { findings: [] },
      { operationKey: '00000000-0000-0000-0000-000000000000' },
      { expectedSourceSha256: 'A'.repeat(64) },
    ])
      expect(humanSchema.safeParse({ ...human(), ...changed }).success).toBe(false);
  });
  it('requires every dedicated human and projection key without extra authority fields', () => {
    for (const [schema, value] of [
      [humanSchema, human()],
      [inputSchema, input()],
    ] as const) {
      expect(schema.safeParse({ ...value, proof: 'trusted' }).success).toBe(false);
      for (const key of Object.keys(value)) {
        const copy: Record<string, unknown> = { ...value };
        delete copy[key];
        expect(schema.safeParse(copy).success, key).toBe(false);
      }
    }
  });
  it('refuses nullable/coerced/nonfinite metrics, unsafe exposure and reviewer attribution', () => {
    for (const changed of [
      { posture_score: null },
      { posture_score: '74' },
      { posture_score: Infinity },
      { posture_score: 101 },
      { estimated_exposure_inr: null },
      { estimated_exposure_inr: 1.5 },
      { estimated_exposure_inr: Number.MAX_SAFE_INTEGER + 1 },
      { reviewer_id: id(5) },
    ])
      expect(inputSchema.safeParse({ ...input(), ...changed }).success).toBe(false);
    for (const changed of [
      { score: null },
      { score: NaN },
      { score: -1 },
      { risk_points: 1 },
      { title: '😀'.repeat(301) },
      { rationale: 'é'.repeat(10001) },
    ])
      expect(
        inputSchema.safeParse({ ...input(), findings: [{ ...input().findings[0], ...changed }] })
          .success,
      ).toBe(false);
  });
  it('requires unique complete control coverage while retaining findings and library order', () => {
    for (const changed of [
      { findings: [] },
      { library_control_ids: [] },
      { library_control_ids: ['CTRL-2'] },
      { library_control_ids: ['CTRL-1', 'CTRL-1'] },
      { findings: [...input().findings, ...input().findings] },
    ])
      expect(inputSchema.safeParse({ ...input(), ...changed }).success).toBe(false);
    const reversed = {
      ...input(),
      library_control_ids: ['CTRL-1', 'CTRL-2'],
      findings: [{ ...input().findings[0], control_id: 'CTRL-2' }, ...input().findings],
    };
    expect(inputSchema.parse(reversed).findings[0]?.control_id).toBe('CTRL-2');
    expect(inputSchema.parse(reversed).library_control_ids[0]).toBe('CTRL-1');
    expect(
      inputSchema.safeParse({
        ...input(),
        library_control_ids: Array.from({ length: 501 }, (_, i) => `CTRL-${i}`),
      }).success,
    ).toBe(false);
  });
  it('accepts each exact SQL response state and acknowledgement', () => {
    expect(sourceSchema.safeParse(source()).success).toBe(true);
    expect(
      previewSchema.safeParse({
        source_text: '{}',
        source_sha256: hash,
        publication_allowed: false,
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        run_id: id(6),
        operation_key: id(4),
        requested_receipt: '4',
        replayed: false,
      }).success,
    ).toBe(true);
    for (const value of [
      { missing: true },
      requested(),
      uncertain(),
      unpublished(),
      { ...unpublished(), review: review() },
    ])
      expect(readbackSchema.safeParse(value).success).toBe(true);
    expect(settlementSchema.safeParse({ ...unpublished(), replayed: true }).success).toBe(true);
    expect(
      reviewSchema.safeParse({ reviewed_receipt: '9', publication_allowed: false, replayed: false })
        .success,
    ).toBe(true);
  });
  it('requires complete strict source, preview and acknowledgement fields', () => {
    for (const [schema, value] of [
      [sourceSchema, source()],
      [previewSchema, { source_text: '{}', source_sha256: hash, publication_allowed: false }],
      [
        requestSchema,
        { run_id: id(6), operation_key: id(4), requested_receipt: '4', replayed: true },
      ],
      [reviewSchema, { reviewed_receipt: '9', publication_allowed: false, replayed: true }],
    ] as const) {
      expect(schema.safeParse({ ...value, unknown: true }).success).toBe(false);
      for (const key of Object.keys(value)) {
        const copy: Record<string, unknown> = { ...value };
        delete copy[key];
        expect(schema.safeParse(copy).success, key).toBe(false);
      }
    }
  });
  it('retains SQL btrim-space review semantics without changing whitespace policy', () => {
    expect(
      readbackSchema.safeParse({
        ...unpublished(),
        review: { ...review(), reason: '\tReviewed synthetic draft only.\t' },
      }).success,
    ).toBe(true);
  });
  it('refuses empty findings, changed section order and evidence certification', () => {
    const valid = output();
    const empty = {
      ...valid,
      sections: [
        valid.sections[0],
        { ...valid.sections[1], items: [] },
        ...valid.sections.slice(2),
      ],
    };
    expect(readbackSchema.safeParse({ ...unpublished(), output: empty }).success).toBe(false);
    expect(
      readbackSchema.safeParse({
        ...unpublished(),
        output: { ...valid, sections: [...valid.sections].reverse() },
      }).success,
    ).toBe(false);
    expect(
      readbackSchema.safeParse({
        ...unpublished(),
        output: { ...valid, cited_evidence_ids: [id(1)] },
      }).success,
    ).toBe(false);
  });
  it('accepts first claim and exact uncertain/settled replays', () => {
    expect(
      claimSchema.safeParse({ claimed: true, expires_at: expiry, readback: uncertain() }).success,
    ).toBe(true);
    for (const readback of [uncertain(), unpublished()])
      expect(
        claimSchema.safeParse({ claimed: false, invocation_uncertain: true, readback }).success,
      ).toBe(true);
  });
  it('does not claim opaque source/output strings or matching digests are trustworthy', () => {
    expect(readbackSchema.safeParse(unpublished()).success).toBe(true);
  });
  it.each(['source_id', 'tenant_id', 'engagement_id', 'assessment_run_id'])(
    'refuses malformed %s',
    (field) => {
      for (const value of [
        '00000000-0000-0000-0000-000000000000',
        id(1).toUpperCase().replace('10000000', 'ABCDEF00'),
        'invalid',
      ])
        expect(sourceSchema.safeParse({ ...source(), [field]: value }).success).toBe(false);
    },
  );
  it('preserves PostgreSQL canonical nonnil UUID acceptance without adding a version restriction', () => {
    const imported = '00000000-0000-0000-0000-000000000001';
    expect(
      sourceSchema.safeParse({ ...source(), source_id: imported, assessment_run_id: imported })
        .success,
    ).toBe(true);
  });
  it('refuses Board v1 source identity, mismatched assessment IDs and runtime/source reuse', () => {
    expect(
      sourceSchema.safeParse({
        ...source(),
        schema_version: 1,
        kind: 'board_source',
        request_id: id(1),
      }).success,
    ).toBe(false);
    expect(sourceSchema.safeParse({ ...source(), assessment_run_id: id(9) }).success).toBe(false);
    expect(readbackSchema.safeParse({ ...requested(), run_id: id(1) }).success).toBe(false);
  });
  it('refuses missing fields and unknown authority-bearing fields', () => {
    const values = [requested(), uncertain(), unpublished()];
    for (const value of values) {
      expect(readbackSchema.safeParse({ ...value, publication_token: 'synthetic' }).success).toBe(
        false,
      );
      for (const key of Object.keys(value)) {
        const copy: Record<string, unknown> = { ...value };
        delete copy[key];
        expect(readbackSchema.safeParse(copy).success, key).toBe(false);
      }
    }
    expect(sourceSchema.safeParse({ ...source(), request_id: id(10) }).success).toBe(false);
    expect(readbackSchema.safeParse({ missing: true, source_text: '{}' }).success).toBe(false);
  });
  it.each(['publication_allowed', 'review_required', 'citation_verification'])(
    'refuses widened %s',
    (key) => {
      expect(
        readbackSchema.safeParse({
          ...requested(),
          [key]: key === 'citation_verification' ? 'verified' : key === 'publication_allowed',
        }).success,
      ).toBe(false);
    },
  );
  it('refuses legacy claim shape, wrong expiry, false replay without uncertainty and requested replay', () => {
    for (const value of [
      { claimed: true, expires_at_ms: 123, readback: uncertain() },
      { claimed: true, expires_at: '2026-10-13T12:06:00Z', readback: uncertain() },
      { claimed: false, readback: uncertain() },
      { claimed: false, invocation_uncertain: false, readback: uncertain() },
      { claimed: false, invocation_uncertain: true, readback: requested() },
      { claimed: true, expires_at: expiry, readback: unpublished() },
    ])
      expect(claimSchema.safeParse(value).success).toBe(false);
  });
  it('refuses state-conflicting optional fields and settlement replay fields in ordinary readback', () => {
    expect(
      readbackSchema.safeParse({ ...requested(), ...uncertain(), state: 'requested' }).success,
    ).toBe(false);
    expect(readbackSchema.safeParse({ ...uncertain(), review: review() }).success).toBe(false);
    expect(readbackSchema.safeParse({ ...unpublished(), replayed: true }).success).toBe(false);
  });
  it('requires receipt IDs positive canonical bigint and strictly ordered', () => {
    for (const invalid of ['0', '01', '-1', '9223372036854775808', 'invalid', '1e2', 4])
      expect(
        readbackSchema.safeParse({
          ...requested(),
          requested_receipt: { ...receipt(4), id: invalid },
        }).success,
      ).toBe(false);
    expect(
      sourceSchema.safeParse({
        ...source(),
        receipts: { started: receipt(3), completed: receipt(2), finalized: receipt(3) },
      }).success,
    ).toBe(false);
    for (const key of [
      'claimed_receipt',
      'started_receipt',
      'completed_receipt',
      'settled_receipt',
    ])
      expect(readbackSchema.safeParse({ ...unpublished(), [key]: receipt(4) }).success).toBe(false);
  });
  it('binds review to retained response hash and later receipt', () => {
    for (const changed of [
      { receipt: receipt(8) },
      { response_output_sha256: 'b'.repeat(64) },
      { decision: 'published' },
      { reason: 'too short' },
      { reason: ' ' + review().reason },
      { review_key: '00000000-0000-0000-0000-000000000000' },
    ])
      expect(
        readbackSchema.safeParse({ ...unpublished(), review: { ...review(), ...changed } }).success,
      ).toBe(false);
  });
  it('accepts SQL Unicode title character bounds without inheriting Board-v1 byte bounds', () => {
    expect(
      readbackSchema.safeParse({
        ...unpublished(),
        output: { ...output(), title: '😀'.repeat(300) },
      }).success,
    ).toBe(true);
    expect(
      readbackSchema.safeParse({
        ...unpublished(),
        output: { ...output(), title: '😀'.repeat(301) },
      }).success,
    ).toBe(false);
  });
  it('pins renderer configuration and refuses injected output fields', () => {
    for (const key of ['renderer_config_text', 'renderer_config_sha256', 'renderer_config_version'])
      expect(readbackSchema.safeParse({ ...requested(), [key]: 'substituted' }).success).toBe(
        false,
      );
    expect(
      readbackSchema.safeParse({ ...unpublished(), output: { ...output(), authority: 'approved' } })
        .success,
    ).toBe(false);
  });
  it('enforces UTF8 bounds, scalar validity, title character bounds and offset timestamps', () => {
    for (const value of ['\0', '\ud800', 'é'.repeat(524288)])
      expect(sourceSchema.safeParse({ ...source(), controls_text: value }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...source(), title: '😀'.repeat(300) }).success).toBe(true);
    expect(sourceSchema.safeParse({ ...source(), title: '😀'.repeat(301) }).success).toBe(false);
    expect(
      sourceSchema.safeParse({ ...source(), completed_at: '2026-10-13T12:00:00' }).success,
    ).toBe(false);
    expect(
      sourceSchema.safeParse({ ...source(), completed_at: '2026-10-13T12:02:00Z' }).success,
    ).toBe(false);
    expect(
      previewSchema.safeParse({
        source_text: 'x'.repeat(1048577),
        source_sha256: hash,
        publication_allowed: false,
      }).success,
    ).toBe(false);
  });
});
