import { describe, it, expect } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  verifyFrozenHumanControlReview,
  renderPublicControlReportAppendix,
} from './public-control-provenance';
import { publicReportFixture, sha, ids } from './public-control-provenance.test-helper';
describe('frozen public review report provenance', () => {
  it('rejects changed but still canonical public text when its retained digest is not updated', () => {
    const { human, scope } = publicReportFixture();
    const payload = JSON.parse(human.capture.payload_text);
    payload.candidates[0].excerpt = 'A different plausible public statement';
    human.capture.payload_text = canonicalJson(payload);
    expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
  });
  it('rejects a forged retained review request digest even when the request bytes are unchanged', () => {
    const { human, scope } = publicReportFixture();
    human.review.request_sha256 = 'f'.repeat(64);
    expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
  });

  it.each(['declarations_verified', 'evidence_verified', 'review_required'] as const)(
    'never accepts a changed %s flag',
    (field) => {
      const { human, scope } = publicReportFixture();
      const changed = { ...human, [field]: field === 'review_required' ? false : true };
      expect(() => verifyFrozenHumanControlReview(changed, scope)).toThrow();
    },
  );
  it('rejects changed packet question meaning or conditional flags despite refreshed packet provenance', () => {
    for (const field of ['prompt', 'conditional']) {
      const { human, scope } = publicReportFixture();
      const controls = JSON.parse(scope.controlsText);
      if (field === 'prompt') controls[0].assessment_questions[0].prompt = 'Reworded question';
      else controls[0].sdf_only = !controls[0].sdf_only;
      scope.controlsText = JSON.stringify(controls);
      const result = JSON.parse(scope.resultText);
      result.questionnaire_provenance.source_library_digest = sha(scope.controlsText);
      scope.resultText = JSON.stringify(result);
      expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
    }
  });

  it('preserves explicitUnknown, omittedUnknown, unsupported questions and qualified public coverage', () => {
    const { human, scope } = publicReportFixture();
    const a = verifyFrozenHumanControlReview(human, scope);
    expect(a.controls).toHaveLength(46);
    expect(
      a.controls
        .flatMap((c) => c.questions)
        .some((q) => q.judgment === 'explicit' && q.answer === null && q.rationale),
    ).toBe(true);
    expect(
      a.controls
        .flatMap((c) => c.questions)
        .some((q) => q.judgment === 'omitted' && q.answer === null && q.rationale === null),
    ).toBe(true);
    expect(a.controls.flatMap((c) => c.questions).some((q) => q.type !== 'boolean')).toBe(true);
    expect(a.pages[0]).toMatchObject({ truncated: true, coverageReasons: ['excerpt_limit'] });
    expect(a.applicability.sdfSelfAttested).toBeNull();
    expect(a.declarationsVerified).toBe(false);
    expect(a.evidenceVerified).toBe(false);
    const html = renderPublicControlReportAppendix(a);
    expect(html).toContain('context demo');
    expect(html).toContain('privacy: unavailable');
    expect(html).toContain('consent: unexamined');
    expect(html).toContain('Omitted judgment — Unknown');
    expect(html).toContain('Explicit Unknown');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<script>');
  });
  it.each([true, false])(
    'retains a coherent %s declaration as unverified human judgment',
    (answer) => {
      const { human, scope } = publicReportFixture();
      const request = JSON.parse(human.review.request_text);
      const controlId = Object.keys(request.answers)[0]!;
      const questionId = Object.keys(request.answers[controlId])[0]!;
      request.answers[controlId][questionId].answer = answer;
      request.answers[controlId][questionId].rationale =
        'Human declaration; implementation evidence remains unverified.';
      human.review.request_text = canonicalJson(request);
      human.review.request_sha256 = sha(human.review.request_text);
      const snapshot = JSON.parse(human.review.snapshot_text);
      snapshot.request = request;
      snapshot.normalizedAnswers[controlId][questionId] = answer;
      human.review.snapshot_text = canonicalJson(snapshot);
      human.review.snapshot_sha256 = sha(human.review.snapshot_text);
      const input = JSON.parse(human.worker_input.text);
      input.answers = snapshot.normalizedAnswers;
      human.worker_input.text = canonicalJson(input);
      human.worker_input.sha256 = sha(human.worker_input.text);
      const result = JSON.parse(scope.resultText);
      const declaration = result.questionnaire_provenance.controls.find(
        (c: { control_id: string }) => c.control_id === controlId,
      );
      declaration.questions.find(
        (q: { question_id: string }) => q.question_id === questionId,
      ).declaration = answer ? 'caller_affirmed' : 'caller_denied';
      declaration.caller_affirmed_count = answer ? 1 : 0;
      declaration.caller_denied_count = answer ? 0 : 1;
      declaration.unknown_count -= 1;
      declaration.answer_state = declaration.unknown_count
        ? 'partially_answered'
        : 'caller_declared_unverified';
      scope.resultText = JSON.stringify(result);
      const appendix = verifyFrozenHumanControlReview(human, scope);
      expect(
        appendix.controls
          .find((c) => c.controlId === controlId)
          ?.questions.find((q) => q.questionId === questionId),
      ).toMatchObject({ answer, judgment: 'explicit' });
      expect(appendix.declarationsVerified).toBe(false);
      expect(appendix.evidenceVerified).toBe(false);
    },
  );
  it.each(['tenant_id', 'engagement_id', 'assessment_run_id'] as const)(
    'refuses substituted %s',
    (field) => {
      const { human, scope } = publicReportFixture();
      human[field] = ids.report;
      expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
    },
  );
  it.each(['worker_input', 'review_request', 'review_snapshot', 'payload', 'pages', 'manifest'])(
    'refuses changed exact %s bytes without a matching hash',
    (part) => {
      const { human, scope } = publicReportFixture();
      if (part === 'worker_input') human.worker_input.text += ' ';
      if (part === 'review_request') human.review.request_text += ' ';
      if (part === 'review_snapshot') human.review.snapshot_text += ' ';
      if (part === 'payload') human.capture.payload_text += ' ';
      if (part === 'pages') human.capture.page_sources_text += ' ';
      if (part === 'manifest') human.catalogue.manifest_text += ' ';
      expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
    },
  );
  it('refuses a fully rehashed forged manifest and duplicate decoded capture keys', () => {
    const { human, scope } = publicReportFixture();
    human.catalogue.manifest_text = '{}';
    human.catalogue.manifest_sha256 = sha('{}');
    expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
    const f = publicReportFixture();
    f.human.capture.page_sources_text = '[{"page":"root","p\\u0061ge":"root"}]';
    f.human.capture.page_sources_sha256 = sha(f.human.capture.page_sources_text);
    expect(() => verifyFrozenHumanControlReview(f.human, f.scope)).toThrow();
  });
  it('refuses valid-looking changed normalized answers even when snapshot/input hashes are refreshed', () => {
    const { human, scope } = publicReportFixture();
    const s = JSON.parse(human.review.snapshot_text);
    const id = Object.keys(s.normalizedAnswers).find(
      (id) => Object.keys(s.normalizedAnswers[id]).length,
    )!;
    s.normalizedAnswers[id][Object.keys(s.normalizedAnswers[id])[0]!] = true;
    human.review.snapshot_text = canonicalJson(s);
    human.review.snapshot_sha256 = sha(human.review.snapshot_text);
    expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
  });
  it('refuses unsupported candidate ordinals or facets and wrong capture receipt/source page', () => {
    for (const change of ['ordinal', 'facet', 'receipt', 'page']) {
      const { human, scope } = publicReportFixture();
      if (change === 'receipt') human.capture.capture_receipt.id = '99';
      else if (change === 'page') {
        human.capture.page_sources[0]!.finalUrl = 'https://other.test/';
        human.capture.page_sources_text = JSON.stringify(human.capture.page_sources);
        human.capture.page_sources_sha256 = sha(human.capture.page_sources_text);
      } else {
        const request = JSON.parse(human.review.request_text);
        const judgment =
          request.answers['DPDPA-GOV-002'][Object.keys(request.answers['DPDPA-GOV-002'])[0]!];
        judgment.candidateOrdinals = [change === 'ordinal' ? 128 : 1];
        if (change === 'facet') {
          const payload = JSON.parse(human.capture.payload_text);
          payload.candidates[0].facet = 'security_statement';
          human.capture.payload_text = canonicalJson(payload);
          human.capture.payload_sha256 = sha(human.capture.payload_text);
          request.expectedSource.payloadSha256 = human.capture.payload_sha256;
        }
        human.review.request_text = canonicalJson(request);
        human.review.request_sha256 = sha(human.review.request_text);
        const s = JSON.parse(human.review.snapshot_text);
        s.request = request;
        human.review.snapshot_text = canonicalJson(s);
        human.review.snapshot_sha256 = sha(human.review.snapshot_text);
      }
      expect(() => verifyFrozenHumanControlReview(human, scope)).toThrow();
    }
  });
  it('returns an independent frozen appendix without retaining mutable input aliases', () => {
    const { human, scope } = publicReportFixture();
    const appendix = verifyFrozenHumanControlReview(human, scope);
    const original = structuredClone(appendix);
    human.capture.page_sources[0]!.requestedUrl = 'https://changed.test/';
    human.catalogue.library_version = 'changed' as '0.1.1';
    expect(appendix).toEqual(original);
  });
});
