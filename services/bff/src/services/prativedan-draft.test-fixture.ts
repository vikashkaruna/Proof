/** Synthetic byte transcripts only; never acceptance evidence or SQL authority. */
import { canonicalJson } from '@axiom/ledger';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  type PrativedanDraftOutput,
} from '@axiom/types';
import { preparePrativedanDraftSource, prativedanTextHash } from './prativedan-draft-source.js';
const ids = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  engagement_id: '22222222-2222-4222-8222-222222222222',
  assessment_run_id: '33333333-3333-4333-8333-333333333333',
  source_id: '44444444-4444-4444-8444-444444444444',
  run_id: '55555555-5555-4555-8555-555555555555',
  operation_key: '66666666-6666-4666-8666-666666666666',
};
const receipt = (id: string, char: string) => ({ id, entry_hash: char.repeat(64) });
export function sourceFixture() {
  const controls = [
    {
      id: 'C-1',
      title: 'संरक्षण <review>',
      domain: 'Security',
      severity: 'high',
      library_version: 'test-v1',
      sdf_only: false,
      children_only: false,
      assessment_questions: [{ id: 'Q-1', type: 'boolean' }],
    },
  ];
  const controlsText = JSON.stringify(controls);
  const result = {
    library_version: 'test-v1',
    posture_score: 30,
    estimated_exposure_inr: 123456,
    findings: [{ control_id: 'C-1', score: 30, rationale: 'Unknown questionnaire declaration.' }],
    questionnaire_provenance: {
      version: 1,
      source_library_version: 'test-v1',
      source_library_digest: prativedanTextHash(controlsText),
      estimates: 'provisional',
      review_required: true,
      controls: [
        {
          control_id: 'C-1',
          questions: [{ question_id: 'Q-1', declaration: 'unknown' }],
          known_boolean_question_count: 1,
          caller_affirmed_count: 0,
          caller_denied_count: 0,
          unknown_count: 1,
          answer_state: 'unknown',
          applicability_state: 'unconditional',
        },
      ],
      applicability: {
        sdf_self_attested: { value: null, provenance: 'unknown' },
        processes_children: { value: null, provenance: 'unknown' },
        processes_health: { value: null, provenance: 'unknown' },
      },
    },
  };
  const resultText = JSON.stringify(result);
  const receipts = {
    started: receipt('1', '1'),
    completed: receipt('2', '2'),
    finalized: receipt('3', '3'),
  };
  const source = {
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'board_source',
    request_id: ids.source_id,
    tenant_id: ids.tenant_id,
    engagement_id: ids.engagement_id,
    assessment_run_id: ids.assessment_run_id,
    library_version: 'test-v1',
    controls_text: controlsText,
    controls_sha256: prativedanTextHash(controlsText),
    result_text: resultText,
    result_sha256: prativedanTextHash(resultText),
    completed_at: '2026-10-01T11:00:00Z',
    finalized_at: '2026-10-01T12:00:00Z',
    receipts,
    limitations: ['Recorded questionnaire computation; no independent evidence verification.'],
  };
  // Deliberate PostgreSQL-like whitespace proves source bytes are never reserialized.
  const sourceText = JSON.stringify(source, null, 1);
  const witness = {
    ...ids,
    title: 'Synthetic draft <review>',
    library_version: 'test-v1',
    source_text: sourceText,
    source_sha256: prativedanTextHash(sourceText),
    controls_sha256: source.controls_sha256,
    result_sha256: source.result_sha256,
    receipts: structuredClone(receipts),
  };
  const { run_id: _, operation_key: __, ...sourceWitness } = witness;
  const request = {
    operationKey: ids.operation_key,
    engagementId: ids.engagement_id,
    assessmentRunId: ids.assessment_run_id,
    expectedSourceSha256: witness.source_sha256,
    sourceReviewed: true,
  };
  return { ids, controls, result, source, witness: sourceWitness, request };
}
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
export function outputFixture() {
  const fixture = sourceFixture();
  const prepared = preparePrativedanDraftSource(fixture.witness, fixture.request);
  const input = prepared.rendererInput;
  const output: PrativedanDraftOutput = {
    title: input.title,
    kind: 'board',
    sections: [
      {
        type: 'executive_summary',
        title: 'Executive summary',
        body: `Declared posture score: 30/100 (Critical; provisional). Estimated statutory exposure (provisional): ₹0.01 Cr. 1 findings included for review. Library version: test-v1.`,
      },
      {
        type: 'findings_table',
        title: 'Findings for review (source order)',
        items: input.findings.map((finding) => ({ ...finding, risk_points: null })),
      },
      {
        type: 'library',
        title: 'Control library',
        body: 'Referenced library version: test-v1. Draft input declares 1 controls; frozen source verification remains required.',
      },
      {
        type: 'attribution',
        title: 'Draft attribution and review status',
        body: 'Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.',
      },
    ],
    cited_evidence_ids: [],
    generated_by_agent: 'prativedan',
    rendered_html: '',
    review_required: true,
    citation_verification: 'unverified_references',
  };
  const [summary, findings, library, attribution] = output.sections;
  output.rendered_html = `<h1>${escapeHtml(output.title)}</h1>\n<div class="axiom-cover"><p>Posture: <strong>30/100 (Critical; provisional)</strong></p></div>\n<h2>${summary.title}</h2>\n<p>${escapeHtml(summary.body)}</p>\n<h2>${findings.title}</h2>\n<table><thead><tr><th>Control</th><th>Title</th><th>Severity</th><th>Score</th><th>Risk pts</th></tr></thead><tbody>${findings.items.map((item) => `<tr><td>${item.control_id}</td><td>${escapeHtml(item.title)}</td><td>${item.severity}</td><td>30.0</td><td></td></tr>`).join('')}</tbody></table>\n<h2>${library.title}</h2>\n<p>${escapeHtml(library.body)}</p>\n<h2>${attribution.title}</h2>\n<p>${escapeHtml(attribution.body)}</p>`;
  // Independent Python-like bytes may differ in numeric lexical forms.
  const normalizedInputText = JSON.stringify(input, null, 1).replace(
    '"posture_score": 30',
    '"posture_score": 30.0',
  );
  const outputText = JSON.stringify(output, null, 1);
  const witness = {
    ...fixture.ids,
    source_sha256: prepared.witness.source_sha256,
    request_sha256: prepared.requestSha256,
    runtime_normalized_input_sha256: prativedanTextHash(normalizedInputText),
    runtime_output_sha256: prativedanTextHash(outputText),
    agent: 'prativedan',
    renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
    renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    agent_version: '0.1.0',
    correlation_id: fixture.ids.operation_key,
    target_ref: fixture.ids.engagement_id,
    requested_receipt: receipt('4', '4'),
    started_receipt: receipt('5', '5'),
    completed_receipt: receipt('6', '6'),
  };
  const envelope = {
    ...witness,
    renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
    normalized_input_text: normalizedInputText,
    runtime_output_text: outputText,
    output,
    review_required: true,
    citation_verification: 'unverified_references',
  };
  return { prepared, envelope, witness, responseText: canonicalJson(output) };
}
