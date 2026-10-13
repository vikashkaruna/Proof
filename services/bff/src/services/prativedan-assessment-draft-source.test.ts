import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
} from '@axiom/types';
import { outputFixture } from './prativedan-draft.test-fixture.js';
import { prativedanTextHash } from './prativedan-draft-source.js';
import { preparePrativedanAssessmentDraftSource } from './prativedan-assessment-draft-source.js';

/** Synthetic unit witness only; not PostgreSQL interoperability or authority. */
function fixture() {
  const old = outputFixture();
  const { request_id: _boardRequest, ...base } = old.prepared.source;
  const source = {
    ...base,
    schema_version: 2,
    kind: 'prativedan_assessment_source',
    source_id: base.assessment_run_id,
    title: old.prepared.witness.title,
    limitations: [
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.',
    ],
  };
  const sourceText = canonicalJson(source);
  const request = { ...old.prepared.request, expectedSourceSha256: prativedanTextHash(sourceText) };
  const requestText = canonicalJson(request);
  const journal = {
    schema_version: 2,
    kind: 'prativedan_unpublished_draft',
    tenant_id: source.tenant_id,
    engagement_id: source.engagement_id,
    source_id: source.source_id,
    assessment_run_id: source.assessment_run_id,
    operation_key: request.operationKey,
    actor_id: old.envelope.tenant_id,
    run_id: old.envelope.run_id,
    source_text: sourceText,
    source_sha256: request.expectedSourceSha256,
    request_text: requestText,
    request_sha256: prativedanTextHash(requestText),
    renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
    renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
    renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    requested_receipt: old.envelope.requested_receipt,
    state: 'requested',
    publication_allowed: false,
    review_required: true,
    citation_verification: 'unverified_references',
  };
  return { journal, source, requestText, expectedInput: old.prepared.rendererInput };
}

describe('dedicated assessment source byte boundary', () => {
  it('uses the embedded completed-assessment title and retained finding order', () => {
    const f = fixture();
    const result = preparePrativedanAssessmentDraftSource(f.journal, f.requestText);
    expect(result.source.source_id).toBe(result.source.assessment_run_id);
    expect(result.rendererInput).toEqual(f.expectedInput);
  });
  it.each(['source_sha256', 'request_sha256'])('refuses forged %s', (field) => {
    const f = fixture();
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        { ...f.journal, [field]: 'f'.repeat(64) },
        f.requestText,
      ),
    ).toThrow();
  });
  it('refuses a request with different retained bytes even when semantically identical', () => {
    const f = fixture();
    expect(() => preparePrativedanAssessmentDraftSource(f.journal, f.requestText + ' ')).toThrow();
  });
  it('refuses a Board source even with recalculated commitments', () => {
    const f = fixture();
    const sourceText = canonicalJson({ ...f.source, kind: 'board_source', schema_version: 1 });
    const requestText = canonicalJson({
      ...JSON.parse(f.requestText),
      expectedSourceSha256: prativedanTextHash(sourceText),
    });
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        {
          ...f.journal,
          source_text: sourceText,
          source_sha256: prativedanTextHash(sourceText),
          request_text: requestText,
          request_sha256: prativedanTextHash(requestText),
        },
        requestText,
      ),
    ).toThrow();
  });
  it('refuses duplicate decoded source members despite matching byte hashes', () => {
    const f = fixture();
    const sourceText = f.journal.source_text.replace('"title":', '"title":"forged","title":');
    const requestText = canonicalJson({
      ...JSON.parse(f.requestText),
      expectedSourceSha256: prativedanTextHash(sourceText),
    });
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        {
          ...f.journal,
          source_text: sourceText,
          source_sha256: prativedanTextHash(sourceText),
          request_text: requestText,
          request_sha256: prativedanTextHash(requestText),
        },
        requestText,
      ),
    ).toThrow();
  });
  it('refuses an assessment/source identity swap and a missing journal', () => {
    const f = fixture();
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        { ...f.journal, assessment_run_id: f.journal.run_id },
        f.requestText,
      ),
    ).toThrow();
    expect(() =>
      preparePrativedanAssessmentDraftSource({ missing: true }, f.requestText),
    ).toThrow();
  });
  it('refuses a requested receipt that does not follow source finalization', () => {
    const f = fixture();
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        { ...f.journal, requested_receipt: f.source.receipts.finalized },
        f.requestText,
      ),
    ).toThrow();
  });
});

// Recommit all containing byte hashes: refusal must be numeric, not a stale hash.
it.each(['9007199254740991.1', '1.0000000000000001'])(
  'refuses rounded retained exposure %s after valid recommitment',
  (token) => {
    const f = fixture();
    const result = JSON.parse(f.source.result_text);
    result.estimated_exposure_inr = 'EXPOSURE_TOKEN';
    const resultText = canonicalJson(result).replace('"EXPOSURE_TOKEN"', token);
    const sourceText = canonicalJson({
      ...f.source,
      result_text: resultText,
      result_sha256: prativedanTextHash(resultText),
    });
    const sourceHash = prativedanTextHash(sourceText);
    const requestText = canonicalJson({
      ...JSON.parse(f.requestText),
      expectedSourceSha256: sourceHash,
    });
    expect(() =>
      preparePrativedanAssessmentDraftSource(
        {
          ...f.journal,
          source_text: sourceText,
          source_sha256: sourceHash,
          request_text: requestText,
          request_sha256: prativedanTextHash(requestText),
        },
        requestText,
      ),
    ).toThrow();
  },
);
