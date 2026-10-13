import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
} from '@axiom/types';
import { sourceFixture } from './prativedan-draft.test-fixture.js';
import { preparePrativedanAssessmentDraftSource } from './prativedan-assessment-draft-source.js';
import { prativedanTextHash } from './prativedan-draft-source.js';
import { prativedanFixedDecimal } from './prativedan-decimal.js';
import {
  verifyPrativedanAssessmentDraftOutput as verify,
  verifyPrativedanAssessmentRendering,
} from './prativedan-assessment-draft-output.js';

// Synthetic unit data only. No PostgreSQL execution, actual Python invocation,
// independent receipt custody, or cross-language interoperability is claimed.
const receipt = (id: number) => ({ id: String(id), entry_hash: 'a'.repeat(64) });
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
function fixture(score = 30, exposure = 123456, count = 1, title = 'Dedicated स्रोत <review>') {
  const f = sourceFixture();
  const controls = Array.from({ length: count }, (_, index) => ({
    ...f.controls[0]!,
    id: `C-${index + 1}`,
  }));
  const controlsText = JSON.stringify(controls);
  const result = {
    ...f.result,
    posture_score: score,
    estimated_exposure_inr: exposure,
    findings: controls.map((control) => ({
      ...f.result.findings[0]!,
      control_id: control.id,
      score,
    })),
    questionnaire_provenance: {
      ...f.result.questionnaire_provenance,
      source_library_digest: prativedanTextHash(controlsText),
      controls: controls.map((control) => ({
        ...f.result.questionnaire_provenance.controls[0]!,
        control_id: control.id,
      })),
    },
  };
  const resultText = JSON.stringify(result);
  const source = {
    schema_version: 2,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'prativedan_assessment_source',
    source_id: f.ids.assessment_run_id,
    assessment_run_id: f.ids.assessment_run_id,
    tenant_id: f.ids.tenant_id,
    engagement_id: f.ids.engagement_id,
    title,
    library_version: 'test-v1',
    controls_text: controlsText,
    controls_sha256: prativedanTextHash(controlsText),
    result_text: resultText,
    result_sha256: prativedanTextHash(resultText),
    completed_at: '2026-10-01T11:00:00Z',
    finalized_at: '2026-10-01T12:00:00Z',
    receipts: { started: receipt(1), completed: receipt(2), finalized: receipt(3) },
    limitations: [
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.',
    ],
  };
  const sourceText = JSON.stringify(source, null, 1);
  const requestText = JSON.stringify(
    {
      operationKey: f.ids.operation_key,
      engagementId: f.ids.engagement_id,
      assessmentRunId: source.source_id,
      expectedSourceSha256: prativedanTextHash(sourceText),
      sourceReviewed: true,
    },
    null,
    1,
  );
  const base = {
    schema_version: 2,
    kind: 'prativedan_unpublished_draft',
    tenant_id: source.tenant_id,
    engagement_id: source.engagement_id,
    source_id: source.source_id,
    assessment_run_id: source.source_id,
    actor_id: f.ids.tenant_id,
    operation_key: f.ids.operation_key,
    run_id: f.ids.run_id,
    source_text: sourceText,
    source_sha256: prativedanTextHash(sourceText),
    request_text: requestText,
    request_sha256: prativedanTextHash(requestText),
    renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
    renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
    renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    requested_receipt: receipt(4),
    publication_allowed: false,
    review_required: true,
    citation_verification: 'unverified_references',
    state: 'requested',
  };
  const initial = preparePrativedanAssessmentDraftSource(base, requestText);
  const normalizedInputText = JSON.stringify(initial.rendererInput, null, 1);
  const journal = {
    ...base,
    state: 'invocation_uncertain',
    claimed_receipt: receipt(5),
    normalized_input_text: normalizedInputText,
    runtime_normalized_input_sha256: prativedanTextHash(normalizedInputText),
    claim_expires_at: '2026-10-13T12:05:00+00:00',
  };
  const prepared = preparePrativedanAssessmentDraftSource(journal, requestText);
  const input = prepared.rendererInput;
  const band =
    score >= 85 ? 'Strong' : score >= 65 ? 'Acceptable' : score >= 40 ? 'At Risk' : 'Critical';
  const posture = `${prativedanFixedDecimal(score, 0)}/100 (${band}; provisional)`;
  const output = {
    title,
    kind: 'board',
    generated_by_agent: 'prativedan',
    cited_evidence_ids: [],
    review_required: true,
    citation_verification: 'unverified_references',
    sections: [
      {
        type: 'executive_summary',
        title: 'Executive summary',
        body: `Declared posture score: ${posture}. Estimated statutory exposure (provisional): ₹${prativedanFixedDecimal(exposure / 10000000, 2)} Cr. ${count} findings included for review. Library version: test-v1.`,
      },
      {
        type: 'findings_table',
        title: 'Findings for review (source order)',
        items: input.findings.slice(0, 10).map((item) => ({ ...item, risk_points: null })),
      },
      {
        type: 'library',
        title: 'Control library',
        body: `Referenced library version: test-v1. Draft input declares ${count} controls; frozen source verification remains required.`,
      },
      {
        type: 'attribution',
        title: 'Draft attribution and review status',
        body: 'Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.',
      },
    ],
    rendered_html: '',
  };
  const sections = output.sections;
  output.rendered_html = [
    `<h1>${escape(title)}</h1>`,
    `<div class="axiom-cover"><p>Posture: <strong>${escape(posture)}</strong></p></div>`,
    `<h2>Executive summary</h2><p>${escape(sections[0]!.body!)}</p>`,
    '<h2>Findings for review (source order)</h2><table><thead><tr><th>Control</th><th>Title</th><th>Severity</th><th>Score</th><th>Risk pts</th></tr></thead><tbody>' +
      input.findings
        .slice(0, 10)
        .map(
          (item) =>
            `<tr><td>${escape(item.control_id)}</td><td>${escape(item.title)}</td><td>${item.severity}</td><td>${score}</td><td></td></tr>`,
        )
        .join('') +
      '</tbody></table>',
    `<h2>Control library</h2><p>${escape(sections[2]!.body!)}</p>`,
    `<h2>Draft attribution and review status</h2><p>${escape(sections[3]!.body!)}</p>`,
  ].join('\n');
  const outputText = JSON.stringify(output, null, 1);
  const binding = {
    schema_version: 2,
    tenant_id: base.tenant_id,
    engagement_id: base.engagement_id,
    source_id: base.source_id,
    assessment_run_id: base.assessment_run_id,
    run_id: base.run_id,
    operation_key: base.operation_key,
    source_sha256: base.source_sha256,
    request_sha256: base.request_sha256,
    runtime_normalized_input_sha256: journal.runtime_normalized_input_sha256,
    runtime_output_sha256: prativedanTextHash(outputText),
    renderer_config_version: base.renderer_config_version,
    renderer_config_sha256: base.renderer_config_sha256,
    agent: 'prativedan',
    agent_version: '0.1.0',
    correlation_id: base.operation_key,
    target_ref: base.engagement_id,
    requested_receipt: receipt(4),
    claimed_receipt: receipt(5),
    started_receipt: receipt(6),
    completed_receipt: receipt(7),
    claim_expires_at: journal.claim_expires_at,
    completed_at: '2026-10-13T12:04:00+00:00',
  };
  const envelope = {
    ...binding,
    renderer_config_text: base.renderer_config_text,
    normalized_input_text: normalizedInputText,
    runtime_output_text: outputText,
    output,
    review_required: true,
    citation_verification: 'unverified_references',
  };
  const witness = structuredClone(binding);
  return { prepared, journal, requestText, envelope, witness };
}
function recomputed(
  f: ReturnType<typeof fixture>,
  change: (o: ReturnType<typeof fixture>['envelope']['output']) => void,
) {
  change(f.envelope.output);
  f.envelope.runtime_output_text = JSON.stringify(f.envelope.output);
  f.envelope.runtime_output_sha256 = prativedanTextHash(f.envelope.runtime_output_text);
  f.witness.runtime_output_sha256 = f.envelope.runtime_output_sha256;
}
function recovered(f: ReturnType<typeof fixture>) {
  const verified = verify(f.prepared, f.envelope, f.witness);
  const journal = {
    ...f.journal,
    state: 'unpublished',
    draft_id: f.envelope.run_id,
    runtime_output_text: f.envelope.runtime_output_text,
    runtime_output_sha256: f.envelope.runtime_output_sha256,
    response_output_text: verified.responseOutputText,
    response_output_sha256: verified.responseOutputSha256,
    output: verified.output,
    started_receipt: f.witness.started_receipt,
    completed_receipt: f.witness.completed_receipt,
    settled_receipt: receipt(8),
  };
  return preparePrativedanAssessmentDraftSource(journal, f.requestText);
}

describe('unmounted assessment-v2 output semantic and byte guard', () => {
  it('verifies synthetic claimed output with five separate byte domains and exact recovery', () => {
    const f = fixture();
    const verified = verify(f.prepared, f.envelope, f.witness);
    expect(verified.responseOutputSha256).toBe(prativedanTextHash(verified.responseOutputText));
    expect(verified.runtimeOutputSha256).not.toBe(verified.responseOutputSha256);
    expect(verified.output.sections[0].body).toBe(
      'Declared posture score: 30/100 (Critical; provisional). Estimated statutory exposure (provisional): ₹0.01 Cr. 1 findings included for review. Library version: test-v1.',
    );
    expect(verify(recovered(f), f.envelope, f.witness)).toEqual(verified);
  });
  it.each([
    [30.5, 0, '30/100'],
    [31.5, 9007199254740991, '32/100'],
    [84.5, 10050000, '84/100'],
    [85, 26750000, '85/100'],
    [1e-7, 0, '0/100'],
  ])('accepts exact pinned numeric formatting score=%s', (score, exposure, rounded) => {
    const f = fixture(Number(score), Number(exposure));
    expect(verify(f.prepared, f.envelope, f.witness).output.sections[0].body).toContain(
      String(rounded),
    );
  });
  it('supports Unicode/HTML-sensitive 300-character source title and full finding count beyond ten', () => {
    const f = fixture(74, 10000000, 12, '😀'.repeat(300));
    const out = verify(f.prepared, f.envelope, f.witness).output;
    expect(out.sections[1].items).toHaveLength(10);
    expect(out.sections[0].body).toContain('12 findings');
  });
  it('exposes pure rendering fidelity without claiming an invocation or a recorded claim', () => {
    const f = fixture();
    const {
      claimed_receipt: _receipt,
      normalized_input_text: _text,
      runtime_normalized_input_sha256: _hash,
      claim_expires_at: _expiry,
      ...base
    } = f.journal;
    const requested = preparePrativedanAssessmentDraftSource(
      { ...base, state: 'requested' },
      f.requestText,
    );
    expect(verifyPrativedanAssessmentRendering(requested, f.envelope.output)).toEqual(
      f.envelope.output,
    );
    expect(() => verify(requested, f.envelope, f.witness)).toThrow();
    expect(() =>
      verifyPrativedanAssessmentRendering(requested, {
        ...f.envelope.output,
        rendered_html: '<script>bad()</script>',
      }),
    ).toThrow();
  });
  it('never treats the caller envelope as an independent receipt witness', () => {
    const f = fixture();
    expect(() => verify(f.prepared, f.envelope, f.envelope)).toThrow();
    expect(() => verify(f.prepared, f.envelope, undefined)).toThrow();
  });
  it.each([
    'tenant_id',
    'engagement_id',
    'source_id',
    'assessment_run_id',
    'run_id',
    'operation_key',
    'source_sha256',
    'request_sha256',
    'runtime_normalized_input_sha256',
    'runtime_output_sha256',
    'correlation_id',
    'target_ref',
    'renderer_config_version',
    'renderer_config_sha256',
  ])('refuses independently mismatched %s', (key) => {
    const f = fixture();
    expect(() => verify(f.prepared, f.envelope, { ...f.witness, [key]: 'forged' })).toThrow();
  });
  it.each(['requested_receipt', 'claimed_receipt', 'started_receipt', 'completed_receipt'])(
    'refuses borrowed %s or hash substitution',
    (key) => {
      const f = fixture();
      expect(() => verify(f.prepared, f.envelope, { ...f.witness, [key]: receipt(999) })).toThrow();
    },
  );
  it('refuses runtime run as target, receipt disorder and substituted config even with matching witness', () => {
    for (const mutation of [
      { target_ref: fixture().envelope.run_id },
      { started_receipt: receipt(5) },
      { agent_version: '9.9.9' },
      { renderer_config_sha256: 'b'.repeat(64) },
    ]) {
      const f = fixture();
      Object.assign(f.envelope, mutation);
      Object.assign(f.witness, mutation);
      expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    }
  });
  it('checks exact claimed lease, actual completion time including submillisecond expiry and offset equivalence', () => {
    for (const completed of ['2026-10-13T12:05:00.000001Z', '2026-10-13T12:06:00Z']) {
      const f = fixture();
      f.envelope.completed_at = completed;
      f.witness.completed_at = completed;
      expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    }
    const f = fixture();
    f.envelope.completed_at = '2026-10-13T17:34:00+05:30';
    f.witness.completed_at = f.envelope.completed_at;
    expect(() => verify(f.prepared, f.envelope, f.witness)).not.toThrow();
    const changed = { ...f.envelope, claim_expires_at: '2026-10-13T12:06:00Z' };
    expect(() =>
      verify(f.prepared, changed, { ...f.witness, claim_expires_at: changed.claim_expires_at }),
    ).toThrow();
  });
  it('refuses request/source raw byte mutations and recomputed normalized input beyond source projection', () => {
    const f = fixture();
    expect(() =>
      verify(
        {
          ...f.prepared,
          journal: {
            ...f.prepared.journal,
            request_text: f.requestText + ' ',
            request_sha256: prativedanTextHash(f.requestText + ' '),
          },
        },
        f.envelope,
        f.witness,
      ),
    ).toThrow();
    f.envelope.normalized_input_text += ' ';
    f.envelope.runtime_normalized_input_sha256 = prativedanTextHash(
      f.envelope.normalized_input_text,
    );
    f.witness.runtime_normalized_input_sha256 = f.envelope.runtime_normalized_input_sha256;
    expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    const other = fixture();
    const text = JSON.stringify({ ...other.prepared.rendererInput, posture_score: 99 });
    other.journal.normalized_input_text = text;
    other.journal.runtime_normalized_input_sha256 = prativedanTextHash(text);
    other.envelope.normalized_input_text = text;
    other.envelope.runtime_normalized_input_sha256 = prativedanTextHash(text);
    other.witness.runtime_normalized_input_sha256 = prativedanTextHash(text);
    const prepared = preparePrativedanAssessmentDraftSource(other.journal, other.requestText);
    expect(() => verify(prepared, other.envelope, other.witness)).toThrow();
  });
  it('requires a recorded claim and reprojects cached mutable inputs', () => {
    const f = fixture();
    const {
      claimed_receipt: _receipt,
      normalized_input_text: _text,
      runtime_normalized_input_sha256: _hash,
      claim_expires_at: _expiry,
      ...base
    } = f.journal;
    const requested = preparePrativedanAssessmentDraftSource(
      { ...base, state: 'requested' },
      f.requestText,
    );
    expect(() => verify(requested, f.envelope, f.witness)).toThrow();
    f.prepared.rendererInput.posture_score = 99;
    expect(verify(f.prepared, f.envelope, f.witness).output.sections[0].body).toContain('30/100');
  });
  it.each([
    'summary',
    'exposure',
    'count',
    'findings',
    'library',
    'attribution',
    'html',
    'citations',
  ])(
    'refuses semantic %s mutation with recomputed output hash and matching fake caller witness',
    (kind) => {
      const f = fixture(74, 10000000, 2);
      recomputed(f, (o) => {
        if (kind === 'summary')
          o.sections[0]!.body = o.sections[0]!.body!.replace('74/100', '99/100');
        if (kind === 'exposure')
          o.sections[0]!.body = o.sections[0]!.body!.replace('1.00 Cr', '1.01 Cr');
        if (kind === 'count')
          o.sections[0]!.body = o.sections[0]!.body!.replace('2 findings', '1 findings');
        if (kind === 'findings') o.sections[1]!.items!.reverse();
        if (kind === 'library') o.sections[2]!.body = 'Certified current library';
        if (kind === 'attribution') o.sections[3]!.body = 'Approved by founder';
        if (kind === 'html') o.rendered_html = o.rendered_html.replace('74/100', '99/100');
        if (kind === 'citations') Object.assign(o, { cited_evidence_ids: [f.envelope.tenant_id] });
      });
      expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    },
  );
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<!-- hidden -->',
    '<svg></svg>',
  ])('refuses injected unsafe/non-template HTML %s', (extra) => {
    const f = fixture();
    recomputed(f, (o) => {
      o.rendered_html += extra;
    });
    expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
  });
  it.each(['attribute', 'tag', 'row', 'cell', 'header', 'risk', 'score', 'nest'])(
    'refuses changed HTML %s structure or content',
    (kind) => {
      const f = fixture();
      recomputed(f, (o) => {
        if (kind === 'attribute')
          o.rendered_html = o.rendered_html.replace('<table>', '<table onclick="evil()">');
        if (kind === 'tag')
          o.rendered_html = o.rendered_html.replace('<strong>', '<p>').replace('</strong>', '</p>');
        if (kind === 'row')
          o.rendered_html = o.rendered_html.replace('</tbody>', '<tr></tr></tbody>');
        if (kind === 'cell')
          o.rendered_html = o.rendered_html.replace('<td>C-1</td>', '<td>C-2</td>');
        if (kind === 'header')
          o.rendered_html = o.rendered_html.replace('<th>Score</th>', '<th>Verified</th>');
        if (kind === 'risk') o.rendered_html = o.rendered_html.replace('<td></td>', '<td>100</td>');
        if (kind === 'score')
          o.rendered_html = o.rendered_html.replace('<td>30</td>', '<td>31</td>');
        if (kind === 'nest')
          o.rendered_html = o.rendered_html.replace(
            '<td>C-1</td>',
            '<td><strong>C-1</strong></td>',
          );
      });
      expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    },
  );
  it('refuses output JSON duplicate keys, declared-output differences and raw-hash-only substitution', () => {
    const f = fixture();
    const text = f.envelope.runtime_output_text.replace('"title":', '"title":"forged","title":');
    f.envelope.runtime_output_text = text;
    f.envelope.runtime_output_sha256 = prativedanTextHash(text);
    f.witness.runtime_output_sha256 = prativedanTextHash(text);
    expect(() => verify(f.prepared, f.envelope, f.witness)).toThrow();
    const other = fixture();
    other.envelope.output.title = 'Changed';
    expect(() => verify(other.prepared, other.envelope, other.witness)).toThrow();
    const third = fixture();
    third.envelope.runtime_output_text += ' ';
    expect(() => verify(third.prepared, third.envelope, third.witness)).toThrow();
  });
  it('refuses recovery output/receipt substitutions and rewritten response byte domain', () => {
    const f = fixture();
    const p = recovered(f);
    if (p.journal.state !== 'unpublished') throw new Error('fixture state');
    for (const mutation of [
      { runtime_output_text: p.journal.runtime_output_text + ' ' },
      { started_receipt: receipt(99) },
      {
        response_output_text: p.journal.response_output_text + ' ',
        response_output_sha256: prativedanTextHash(p.journal.response_output_text + ' '),
      },
      { response_output_sha256: 'b'.repeat(64) },
    ]) {
      expect(() =>
        verify({ ...p, journal: { ...p.journal, ...mutation } }, f.envelope, f.witness),
      ).toThrow();
    }
  });
});
