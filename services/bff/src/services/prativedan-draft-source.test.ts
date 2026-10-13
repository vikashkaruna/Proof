import { describe, expect, it } from 'vitest';
import { sourceFixture } from './prativedan-draft.test-fixture.js';
import { preparePrativedanDraftSource, prativedanTextHash } from './prativedan-draft-source.js';

describe('unmounted Prativedan frozen source contract', () => {
  it('preserves exact source bytes and unknown declarations in a bounded source-only input', () => {
    const f = sourceFixture();
    const prepared = preparePrativedanDraftSource(f.witness, f.request);
    expect(prepared.witness.source_text).toBe(f.witness.source_text);
    expect(prepared.interpretation.findings[0]?.display_state).toBe('unknown');
    expect(prepared.rendererInput.findings[0]?.rationale).toContain(
      'answer=unknown; applicability=unconditional; evidence unverified.',
    );
    expect(prepared.rendererInput.reviewer_id).toBeNull();
    expect(prepared.rendererInput.findings[0]).not.toHaveProperty('evidence_ids');
    expect(prepared.requestSha256).not.toBe(prepared.witness.source_sha256);
  });
  it.each(['tenant', 'source', 'engagement', 'run', 'library', 'receipt', 'controls', 'result'])(
    'refuses changed frozen binding even if caller recomputes source digest: %s',
    (mode) => {
      const f = sourceFixture();
      if (mode === 'tenant') f.source.tenant_id = f.ids.run_id;
      if (mode === 'source') f.source.request_id = f.ids.run_id;
      if (mode === 'engagement') f.source.engagement_id = f.ids.run_id;
      if (mode === 'run') f.source.assessment_run_id = f.ids.run_id;
      if (mode === 'library') f.source.library_version = 'foreign';
      if (mode === 'receipt') f.source.receipts.finalized.entry_hash = 'f'.repeat(64);
      if (mode === 'controls') f.source.controls_text += ' ';
      if (mode === 'result') f.source.result_text += ' ';
      f.witness.source_text = JSON.stringify(f.source);
      f.witness.source_sha256 = prativedanTextHash(f.witness.source_text);
      f.request.expectedSourceSha256 = f.witness.source_sha256;
      expect(() => preparePrativedanDraftSource(f.witness, f.request)).toThrow('contract_refused');
    },
  );
  it.each([
    'missing',
    'qid',
    'count',
    'version',
    'foreign-control',
    'duplicate-control',
    'extra-finding',
  ])(
    'rejects unproved source semantics after all self-reported digests are recomputed: %s',
    (mode) => {
      const f = sourceFixture();
      const result: Record<string, unknown> = structuredClone(f.result);
      if (mode === 'missing') delete result.questionnaire_provenance;
      if (mode === 'qid')
        f.result.questionnaire_provenance.controls[0]!.questions[0]!.question_id = 'foreign';
      if (mode === 'count') f.result.questionnaire_provenance.controls[0]!.unknown_count = 0;
      if (mode === 'version') f.result.library_version = 'foreign';
      if (mode === 'foreign-control') f.result.findings[0]!.control_id = 'foreign';
      if (mode === 'extra-finding')
        Object.assign(f.result.findings[0]!, { evidence_ids: [f.ids.run_id] });
      if (mode === 'duplicate-control') f.controls.push(structuredClone(f.controls[0]!));
      f.source.controls_text = JSON.stringify(f.controls);
      f.source.controls_sha256 = prativedanTextHash(f.source.controls_text);
      f.result.questionnaire_provenance.source_library_digest = f.source.controls_sha256;
      f.source.result_text = JSON.stringify(mode === 'missing' ? result : f.result);
      f.source.result_sha256 = prativedanTextHash(f.source.result_text);
      f.witness.controls_sha256 = f.source.controls_sha256;
      f.witness.result_sha256 = f.source.result_sha256;
      f.witness.source_text = JSON.stringify(f.source);
      f.witness.source_sha256 = prativedanTextHash(f.witness.source_text);
      f.request.expectedSourceSha256 = f.witness.source_sha256;
      expect(() => preparePrativedanDraftSource(f.witness, f.request)).toThrow('contract_refused');
    },
  );
  it('does not accept extra caller findings, lost source bytes, or lossy UTF-8', () => {
    const f = sourceFixture();
    expect(() => preparePrativedanDraftSource(f.witness, { ...f.request, findings: [] })).toThrow();
    expect(() =>
      preparePrativedanDraftSource(
        { ...f.witness, source_text: f.witness.source_text + ' ' },
        f.request,
      ),
    ).toThrow();
    expect(() => prativedanTextHash('\ud800')).toThrow();
  });
});
