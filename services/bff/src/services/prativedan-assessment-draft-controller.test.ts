import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
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
import { verifyPrativedanAssessmentDraftOutput } from './prativedan-assessment-draft-output.js';
import {
  PrativedanAssessmentDraftStore,
  type PrativedanAssessmentRpcClient,
} from './prativedan-assessment-draft-store.js';
import { PrativedanAssessmentDraftController } from './prativedan-assessment-draft-controller.js';
// Synthetic RPC/renderer/receipt fixtures only; no PostgreSQL invocation/custody proof.
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
function harness() {
  const f = fixture();
  const requested = structuredClone(f.prepared.journal);
  if (requested.state !== 'invocation_uncertain') throw Error('synthetic fixture state');
  const {
    claimed_receipt: _claimed,
    normalized_input_text: _input,
    runtime_normalized_input_sha256: _ih,
    claim_expires_at: _expiry,
    ...base
  } = requested;
  const requestedJournal = { ...base, state: 'requested' };
  const verified = verifyPrativedanAssessmentDraftOutput(f.prepared, f.envelope, f.witness);
  const unpublished = {
    ...requested,
    state: 'unpublished',
    draft_id: '77777777-7777-4777-8777-777777777777',
    runtime_output_text: f.envelope.runtime_output_text,
    runtime_output_sha256: verified.runtimeOutputSha256,
    response_output_text: verified.responseOutputText,
    response_output_sha256: verified.responseOutputSha256,
    output: verified.output,
    started_receipt: receipt(6),
    completed_receipt: receipt(7),
    settled_receipt: receipt(8),
  };
  let current: unknown = requestedJournal;
  const calls: { role: string; name: string; args: Record<string, unknown> }[] = [];
  let handler: (name: string, args: Record<string, unknown>) => unknown = (name) => {
    if (name === 'read_prativedan_assessment_draft') return current;
    if (name === 'read_prativedan_assessment_runtime_receipts') return f.witness;
    if (name === 'settle_prativedan_assessment_draft') {
      current = unpublished;
      return { ...unpublished, replayed: false };
    }
    if (name === 'request_prativedan_assessment_draft')
      return {
        run_id: base.run_id,
        operation_key: base.operation_key,
        requested_receipt: '4',
        replayed: false,
      };
    if (name === 'preview_prativedan_assessment_source')
      return {
        source_text: base.source_text,
        source_sha256: base.source_sha256,
        publication_allowed: false,
      };
    throw Error('unexpected synthetic RPC');
  };
  const client = (role: string): PrativedanAssessmentRpcClient => ({
    rpc: (name, args) => ({
      abortSignal: async () => {
        calls.push({ role, name, args });
        return { data: handler(name, args), error: null };
      },
    }),
  });
  const store = new PrativedanAssessmentDraftStore({
    humanWriterFactory: () => client('human_action_writer'),
    agentWriterFactory: () => client('agent_ledger_writer'),
  });
  const runtime = {
    invoke: vi.fn(async () => {
      current = requested;
      return f.envelope;
    }),
  };
  const authorizeCurrentHuman = vi.fn(async () => {});
  const isKilled = vi.fn(async () => false);
  const controller = new PrativedanAssessmentDraftController({
    store,
    runtime,
    authorizeCurrentHuman,
    isKilled,
  });
  const context = {
    tenantId: base.tenant_id,
    actorId: base.actor_id,
    sessionId: '88888888-8888-4888-8888-888888888888',
  };
  return {
    f,
    store,
    controller,
    context,
    runtime,
    authorizeCurrentHuman,
    isKilled,
    calls,
    requestedJournal,
    requested,
    unpublished,
    setCurrent: (value: unknown) => {
      current = value;
    },
    setHandler: (value: typeof handler) => {
      handler = value;
    },
  };
}

describe('unmounted assessment v2 scoped store/controller', () => {
  it('previews source and records exact reviewed request with scoped human writer', async () => {
    const h = harness();
    const preview = await h.controller.preview(
      h.context,
      h.f.journal.engagement_id,
      h.f.journal.assessment_run_id,
    );
    expect(preview.source_text).toBe(h.f.journal.source_text);
    const result = await h.controller.request(h.context, h.f.requestText);
    expect(result.journal.state).toBe('requested');
    expect(h.calls.every((c) => c.role === 'human_action_writer')).toBe(true);
    expect(h.calls.find((c) => c.name === 'request_prativedan_assessment_draft')?.args).toEqual({
      t: h.context.tenantId,
      a: h.context.actorId,
      human_text: h.f.requestText,
    });
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it('invokes once, independently loads actual receipt witness then verifies and settles exact byte domains', async () => {
    const h = harness();
    const result = await h.controller.generate(h.context, h.f.requestText);
    expect(result.outcome).toBe('unpublished');
    expect(result.journal.publication_allowed).toBe(false);
    expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
    expect(h.runtime.invoke.mock.calls[0]).toEqual([
      {
        tenant_id: h.f.journal.tenant_id,
        actor_id: h.f.journal.actor_id,
        operation_key: h.f.journal.operation_key,
        engagement_id: h.f.journal.engagement_id,
        assessment_run_id: h.f.journal.assessment_run_id,
        source_id: h.f.journal.source_id,
        run_id: h.f.journal.run_id,
        request_text: h.f.requestText,
        source_sha256: h.f.journal.source_sha256,
      },
    ]);
    const receiptCall = h.calls.find(
      (c) => c.name === 'read_prativedan_assessment_runtime_receipts',
    );
    expect(receiptCall).toEqual({
      role: 'agent_ledger_writer',
      name: 'read_prativedan_assessment_runtime_receipts',
      args: {
        t: h.f.journal.tenant_id,
        k: h.f.journal.operation_key,
        r: h.f.journal.run_id,
        rh: h.f.journal.request_sha256,
        started: '6',
        completed: '7',
      },
    });
    const settlement = h.calls.find((c) => c.name === 'settle_prativedan_assessment_draft');
    expect(settlement?.args.output_text).toBe(h.f.envelope.runtime_output_text);
    expect(settlement?.args.response_text).toBe(canonicalJson(h.f.envelope.output));
  });
  it.each(['requested', 'invocation_uncertain'] as const)(
    'lost dispatch response remains uncertain even readback is %s, no retry or settle',
    async (state) => {
      const h = harness();
      h.runtime.invoke.mockImplementation(async () => {
        h.setCurrent(state === 'requested' ? h.requestedJournal : h.requested);
        throw Error('sensitive provider contents');
      });
      const result = await h.controller.generate(h.context, h.f.requestText);
      expect(result.outcome).toBe('invocation_uncertain');
      expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
      expect(h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')).toBe(false);
      expect(JSON.stringify(result)).not.toContain('sensitive provider contents');
    },
  );
  it('uncertain replay never invokes, including expired claim', async () => {
    const h = harness();
    h.setCurrent(h.requested);
    const result = await h.controller.generate(h.context, h.f.requestText);
    expect(result.outcome).toBe('invocation_uncertain');
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it('settled exact recovery verifies retained bytes and independent receipt proof without invoke or settlement', async () => {
    const h = harness();
    h.setCurrent(h.unpublished);
    const result = await h.controller.reconcile(h.context, h.f.requestText);
    expect(result.state).toBe('unpublished');
    expect(h.runtime.invoke).not.toHaveBeenCalled();
    expect(h.calls.map((c) => c.name)).toEqual([
      'read_prativedan_assessment_draft',
      'read_prativedan_assessment_runtime_receipts',
    ]);
  });
  it.each([true, false])('lost settlement response reads only; committed=%s', async (committed) => {
    const h = harness();
    h.setHandler((name) => {
      if (name === 'read_prativedan_assessment_draft')
        return h.runtime.invoke.mock.calls.length === 0
          ? h.requestedJournal
          : committed && h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')
            ? h.unpublished
            : h.requested;
      if (name === 'read_prativedan_assessment_runtime_receipts') return h.f.witness;
      if (name === 'settle_prativedan_assessment_draft') throw Error('sensitive SQL response lost');
      throw Error('unexpected');
    });
    const result = await h.controller.generate(h.context, h.f.requestText);
    expect(result.outcome).toBe(committed ? 'unpublished' : 'invocation_uncertain');
    expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((c) => c.name === 'settle_prativedan_assessment_draft')).toHaveLength(1);
  });
  it('lost request response uses exact readback without a second request', async () => {
    const h = harness();
    h.setHandler((name) => {
      if (name === 'request_prativedan_assessment_draft') throw Error('lost');
      if (name === 'read_prativedan_assessment_draft') return h.requestedJournal;
      throw Error('unexpected');
    });
    expect((await h.controller.request(h.context, h.f.requestText)).recovered).toBe(true);
    expect(h.calls.filter((c) => c.name === 'request_prativedan_assessment_draft')).toHaveLength(1);
  });
  it.each(['tenant_id', 'actor_id', 'request_text'] as const)(
    'refuses changed trusted readback %s before invocation',
    async (field) => {
      const h = harness();
      h.setCurrent({
        ...h.requestedJournal,
        [field]:
          field === 'request_text' ? h.f.requestText + ' ' : '99999999-9999-4999-8999-999999999999',
      });
      await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow();
      expect(h.runtime.invoke).not.toHaveBeenCalled();
    },
  );
  it('refuses changed run identity after dispatch before receipt load/settlement', async () => {
    const h = harness();
    h.runtime.invoke.mockImplementation(async () => {
      h.setCurrent({ ...h.requested, run_id: '99999999-9999-4999-8999-999999999999' });
      return h.f.envelope;
    });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
    expect(
      h.calls.some(
        (c) =>
          c.name === 'read_prativedan_assessment_runtime_receipts' ||
          c.name === 'settle_prativedan_assessment_draft',
      ),
    ).toBe(false);
  });
  it('refuses forged matching envelope without matching independently loaded witness', async () => {
    const h = harness();
    const fake = structuredClone(h.f.envelope);
    fake.completed_receipt.entry_hash = 'b'.repeat(64);
    h.runtime.invoke.mockImplementation(async () => {
      h.setCurrent(h.requested);
      return fake;
    });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')).toBe(false);
  });
  it('rechecks current human before invocation and refuses removed/expired/quarantined session', async () => {
    const h = harness();
    h.authorizeCurrentHuman
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw Error('current authority refused');
      });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow(
      'prativedan_draft_contract_refused',
    );
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it('kill during runtime prevents any settlement', async () => {
    const h = harness();
    h.runtime.invoke.mockImplementation(async () => {
      h.setCurrent(h.requested);
      h.isKilled.mockResolvedValue(true);
      return h.f.envelope;
    });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')).toBe(false);
  });

  it('simultaneous callers never retry the losing one-shot dispatch', async () => {
    const h = harness();
    let releaseWinner: () => void = () => {};
    const loserEntered = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let attempts = 0;
    h.runtime.invoke.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        await loserEntered;
        h.setCurrent(h.requested);
        return h.f.envelope;
      }
      h.setCurrent(h.requested);
      releaseWinner();
      throw Error('one-shot claim already owned');
    });
    const results = await Promise.all([
      h.controller.generate(h.context, h.f.requestText),
      h.controller.generate(h.context, h.f.requestText),
    ]);
    expect(results.map((value) => value.outcome).sort()).toEqual([
      'invocation_uncertain',
      'unpublished',
    ]);
    expect(h.runtime.invoke).toHaveBeenCalledTimes(2);
    expect(h.calls.filter((c) => c.name === 'settle_prativedan_assessment_draft')).toHaveLength(1);
  });
  it('requires actual independently loaded witness and refuses missing receipt proof without settle', async () => {
    const h = harness();
    h.setHandler((name) => {
      if (name === 'read_prativedan_assessment_draft')
        return h.runtime.invoke.mock.calls.length ? h.requested : h.requestedJournal;
      if (name === 'read_prativedan_assessment_runtime_receipts') return { missing: true };
      throw Error('unexpected');
    });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')).toBe(false);
  });
  it('storage refusal never falls back to service role or table queries', async () => {
    const h = harness();
    h.setHandler(() => {
      throw Error('secret database configuration');
    });
    await expect(h.controller.reconcile(h.context, h.f.requestText)).rejects.toThrow(
      'prativedan_assessment_store_unavailable',
    );
    expect(h.calls.map((c) => c.role)).toEqual(['human_action_writer']);
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it('retained output with recomputed response hash still refuses against actual receipt commitment', async () => {
    const h = harness();
    const bad = structuredClone(h.unpublished);
    bad.runtime_output_text += ' ';
    bad.runtime_output_sha256 = prativedanTextHash(bad.runtime_output_text);
    h.setCurrent(bad);
    await expect(h.controller.reconcile(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it('authority or session expiry after independent receipt load refuses before settlement', async () => {
    const h = harness();
    h.setHandler((name) => {
      if (name === 'read_prativedan_assessment_draft')
        return h.runtime.invoke.mock.calls.length ? h.requested : h.requestedJournal;
      if (name === 'read_prativedan_assessment_runtime_receipts') {
        h.authorizeCurrentHuman.mockRejectedValue(Error('expired session after proof read'));
        return h.f.witness;
      }
      throw Error('unexpected');
    });
    await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow(
      'prativedan_draft_contract_refused',
    );
    expect(h.calls.some((c) => c.name === 'settle_prativedan_assessment_draft')).toBe(false);
    expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
  });
  it('request acknowledgement cannot switch server run identity', async () => {
    const h = harness();
    h.setHandler((name) => {
      if (name === 'request_prativedan_assessment_draft')
        return {
          run_id: '99999999-9999-4999-8999-999999999999',
          operation_key: h.f.journal.operation_key,
          requested_receipt: '4',
          replayed: false,
        };
      if (name === 'read_prativedan_assessment_draft') return h.requestedJournal;
      throw Error('unexpected');
    });
    await expect(h.controller.request(h.context, h.f.requestText)).rejects.toThrow();
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'human review preserves unpublished state with exact readback, lostresponse=%s',
    async (lost) => {
      const h = harness();
      h.setCurrent(h.unpublished);
      const input = {
        reviewKey: '99999999-9999-4999-8999-999999999999',
        expectedHash: h.unpublished.response_output_sha256,
        decision: 'accepted' as const,
        reason: 'Reviewed exact synthetic draft before accepting it.',
      };
      const reviewed = {
        ...h.unpublished,
        review: {
          actor_id: h.context.actorId,
          review_key: input.reviewKey,
          decision: input.decision,
          reason: input.reason,
          response_output_sha256: input.expectedHash,
          receipt: receipt(9),
        },
      };
      h.setHandler((name) => {
        if (name === 'read_prativedan_assessment_draft')
          return h.calls.some((c) => c.name === 'review_prativedan_assessment_draft')
            ? reviewed
            : h.unpublished;
        if (name === 'read_prativedan_assessment_runtime_receipts') return h.f.witness;
        if (name === 'review_prativedan_assessment_draft') {
          if (lost) throw Error('response lost');
          return { reviewed_receipt: '9', publication_allowed: false, replayed: false };
        }
        throw Error('unexpected');
      });
      const result = await h.controller.review(h.context, h.f.requestText, input);
      expect(result.publication_allowed).toBe(false);
      expect(result.review?.receipt.id).toBe('9');
      expect(h.calls.filter((c) => c.name === 'review_prativedan_assessment_draft')).toHaveLength(
        1,
      );
      expect(h.runtime.invoke).not.toHaveBeenCalled();
    },
  );
  it('review refuses stale hash before human review RPC', async () => {
    const h = harness();
    h.setCurrent(h.unpublished);
    await expect(
      h.controller.review(h.context, h.f.requestText, {
        reviewKey: h.f.journal.run_id,
        expectedHash: 'b'.repeat(64),
        decision: 'accepted',
        reason: 'Review cannot accept this changed output.',
      }),
    ).rejects.toThrow();
    expect(h.calls.some((c) => c.name === 'review_prativedan_assessment_draft')).toBe(false);
  });
  it.each(['revoked', 'killed'] as const)(
    'committed settlement remains retained but %s authority prevents exposing success',
    async (mode) => {
      const h = harness();
      h.setHandler((name) => {
        if (name === 'read_prativedan_assessment_draft')
          return h.runtime.invoke.mock.calls.length ? h.requested : h.requestedJournal;
        if (name === 'read_prativedan_assessment_runtime_receipts') return h.f.witness;
        if (name === 'settle_prativedan_assessment_draft') {
          h.setCurrent(h.unpublished);
          if (mode === 'revoked')
            h.authorizeCurrentHuman.mockRejectedValue(Error('session revoked while settling'));
          else h.isKilled.mockResolvedValue(true);
          return { ...h.unpublished, replayed: false };
        }
        throw Error('unexpected');
      });
      await expect(h.controller.generate(h.context, h.f.requestText)).rejects.toThrow(
        'prativedan_draft_contract_refused',
      );
      expect(h.calls.filter((c) => c.name === 'settle_prativedan_assessment_draft')).toHaveLength(
        1,
      );
      expect(h.runtime.invoke).toHaveBeenCalledTimes(1);
      // The committed journal is preserved; only current authorization can expose it later.
    },
  );
  it('invalid session context refuses before any authority/store/runtime operation', async () => {
    const h = harness();
    await expect(
      h.controller.generate({ ...h.context, sessionId: 'bad' }, h.f.requestText),
    ).rejects.toThrow();
    expect(h.authorizeCurrentHuman).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
    expect(h.runtime.invoke).not.toHaveBeenCalled();
  });
});

// CLI protection/mapping tests use fabricated synthetic rows only. They prove
// verifier refusals, not PostgreSQL execution, ledger custody or production use.
function syntheticInteropFixture() {
  const h = harness();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-assessment-verifier-unit-')));
  chmodSync(directory, 0o700);
  const version = h.f.envelope.renderer_config_version;
  const configHash = h.f.envelope.renderer_config_sha256;
  const runtimeDetail = {
    run_id: h.f.journal.run_id,
    request_hash: h.f.journal.request_sha256,
    renderer_config_version: version,
    renderer_config_sha256: configHash,
  };
  function row(id: number, fields: Record<string, unknown> = {}) {
    return {
      id: String(id),
      sequence_no: id,
      tenant_id: h.context.tenantId,
      correlation_id: h.f.journal.operation_key,
      actor_type: 'system',
      actor_id: 'synthetic-assessment-source',
      agent_version: null,
      model_id: null,
      prompt_hash: null,
      action_type: 'synthetic.source',
      target_ref: null,
      input_hash: null,
      output_hash: null,
      result: 'success',
      detail: {},
      occurred_at: h.f.witness.completed_at,
      entry_hash: 'a'.repeat(64),
      ...fields,
    };
  }
  const ledger = [
    row(1),
    row(2),
    row(3),
    row(4, {
      actor_type: 'human',
      actor_id: h.context.actorId,
      target_ref: h.f.journal.run_id,
      action_type: 'prativedan.draft.requested',
      input_hash: h.f.journal.request_sha256,
      output_hash: h.f.journal.source_sha256,
      detail: {
        source_id: h.f.journal.source_id,
        engagement_id: h.f.journal.engagement_id,
        assessment_run_id: h.f.journal.assessment_run_id,
        run_id: h.f.journal.run_id,
        operation_key: h.f.journal.operation_key,
        renderer_config_version: version,
        renderer_config_sha256: configHash,
        publication_allowed: false,
        source_reviewed: true,
      },
    }),
    row(5, {
      actor_id: 'prativedan-draft-controller',
      agent_version: '0.1.0',
      target_ref: h.f.journal.run_id,
      action_type: 'prativedan.draft.claimed',
      input_hash: h.f.journal.runtime_normalized_input_sha256,
      result: 'pending',
      detail: { ...runtimeDetail, source_sha256: h.f.journal.source_sha256, one_shot: true },
    }),
    row(6, {
      actor_type: 'agent',
      actor_id: 'prativedan',
      agent_version: '0.1.0',
      target_ref: h.f.journal.engagement_id,
      action_type: 'report.generated',
      input_hash: h.f.journal.runtime_normalized_input_sha256,
      result: 'pending',
      detail: { ...runtimeDetail, phase: 'started' },
    }),
    row(7, {
      actor_type: 'agent',
      actor_id: 'prativedan',
      agent_version: '0.1.0',
      target_ref: h.f.journal.engagement_id,
      action_type: 'report.generated',
      input_hash: h.f.journal.runtime_normalized_input_sha256,
      output_hash: h.f.witness.runtime_output_sha256,
      detail: { ...runtimeDetail, phase: 'completed', started_entry: '6' },
    }),
  ];
  const settledLedger = [
    ...ledger,
    row(8, {
      actor_id: 'prativedan-draft-controller',
      agent_version: '0.1.0',
      target_ref: h.f.journal.run_id,
      action_type: 'prativedan.draft.settled',
      input_hash: h.f.journal.runtime_normalized_input_sha256,
      output_hash: h.f.witness.runtime_output_sha256,
      detail: {
        ...runtimeDetail,
        source_sha256: h.f.journal.source_sha256,
        response_output_sha256: h.unpublished.response_output_sha256,
        started_receipt: '6',
        completed_receipt: '7',
        publication_allowed: false,
      },
    }),
  ];
  const binding = {
    tenant_id: h.f.journal.tenant_id,
    actor_id: h.f.journal.actor_id,
    operation_key: h.f.journal.operation_key,
    engagement_id: h.f.journal.engagement_id,
    assessment_run_id: h.f.journal.assessment_run_id,
    source_id: h.f.journal.source_id,
    run_id: h.f.journal.run_id,
    request_text: h.f.requestText,
    source_sha256: h.f.journal.source_sha256,
  };
  const artifacts: Record<string, unknown> = {
    'pg-requested.json': {
      schema_version: 1,
      fixture_kind: 'disposable_postgres_assessment_v2',
      requested_readback: h.requestedJournal,
      sql_input_projection: h.f.prepared.rendererInput,
      expected_binding: binding,
    },
    'pg-claim-first.json': {
      claimed: true,
      expires_at: h.f.journal.claim_expires_at,
      readback: h.requested,
    },
    'runtime-envelope.json': h.f.envelope,
    'pg-runtime-witness.json': h.f.witness,
    'pg-runtime-ledger.json': ledger,
    'pg-settled.json': { ...h.unpublished, replayed: false },
    'pg-retained.json': h.unpublished,
    'pg-settle-replay.json': { ...h.unpublished, replayed: true },
    'pg-settled-ledger.json': settledLedger,
  };
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  for (const [name, value] of Object.entries(artifacts)) write(name, value);
  const root = resolve(process.cwd(), '../..');
  const run = (phase: 'runtime' | 'settled') =>
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/check-prativedan-assessment-controller-interoperability.ts',
        phase,
        directory,
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 20000 },
    );
  return {
    h,
    directory,
    artifacts,
    write,
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('synthetic CLI mapping/protection only; no actual SQL evidence', () => {
  it('checks runtime then exact settlement replay/readback with separate publication-false qualifiers', () => {
    const f = syntheticInteropFixture();
    try {
      expect(f.run('runtime')).toContain('settlement remains unproven');
      const args = JSON.parse(readFileSync(join(f.directory, 'settlement-arguments.json'), 'utf8'));
      expect(args.response_text).toBe(canonicalJson(f.h.f.envelope.output));
      expect(args.output_text).toBe(f.h.f.envelope.runtime_output_text);
      expect(f.run('settled')).toContain('publication remains prohibited');
      const proof = JSON.parse(
        readFileSync(join(f.directory, 'settled-verification.json'), 'utf8'),
      );
      expect(proof.publicationAllowed).toBe(false);
      expect(proof.providerAcceptanceProven).toBe(false);
      expect(proof.httpWorkloadAuthenticationProven).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    'binding',
    'claim_replay',
    'witness',
    'ledger_detail',
    'source_review',
    'public_file',
    'symlink_file',
    'public_directory',
  ] as const)('refuses runtime mutation %s', (mutation) => {
    const f = syntheticInteropFixture();
    try {
      if (mutation === 'binding')
        f.write('pg-requested.json', {
          ...(f.artifacts['pg-requested.json'] as Record<string, unknown>),
          expected_binding: { ...f.h.f.journal, request_text: f.h.f.requestText },
        });
      if (mutation === 'claim_replay')
        f.write('pg-claim-first.json', {
          claimed: false,
          invocation_uncertain: true,
          readback: f.h.requested,
        });
      if (mutation === 'witness')
        f.write('pg-runtime-witness.json', {
          ...f.h.f.witness,
          runtime_output_sha256: 'b'.repeat(64),
        });
      if (mutation === 'ledger_detail' || mutation === 'source_review') {
        const rows = structuredClone(f.artifacts['pg-runtime-ledger.json']) as Record<
          string,
          unknown
        >[];
        const target = mutation === 'source_review' ? 3 : 6;
        rows[target]!.detail =
          mutation === 'source_review' ? { source_reviewed: false } : { phase: 'completed' };
        f.write('pg-runtime-ledger.json', rows);
      }
      if (mutation === 'public_file')
        chmodSync(join(f.directory, 'pg-runtime-witness.json'), 0o644);
      if (mutation === 'symlink_file') {
        rmSync(join(f.directory, 'pg-runtime-witness.json'));
        symlinkSync(
          join(f.directory, 'runtime-envelope.json'),
          join(f.directory, 'pg-runtime-witness.json'),
        );
      }
      if (mutation === 'public_directory') chmodSync(f.directory, 0o755);
      expect(() => f.run('runtime')).toThrow();
    } finally {
      f.cleanup();
    }
  });
  it.each([
    'first_replay',
    'lost_retained',
    'different_replay',
    'settled_receipt',
    'ledger_growth',
    'arguments',
  ] as const)('refuses settled mutation %s', (mutation) => {
    const f = syntheticInteropFixture();
    try {
      f.run('runtime');
      if (mutation === 'first_replay')
        f.write('pg-settled.json', { ...f.h.unpublished, replayed: true });
      if (mutation === 'lost_retained') f.write('pg-retained.json', f.h.requested);
      if (mutation === 'different_replay')
        f.write('pg-settle-replay.json', {
          ...f.h.unpublished,
          draft_id: f.h.context.sessionId,
          replayed: true,
        });
      if (mutation === 'settled_receipt') {
        const rows = structuredClone(f.artifacts['pg-settled-ledger.json']) as Record<
          string,
          unknown
        >[];
        rows[7]!.entry_hash = 'b'.repeat(64);
        f.write('pg-settled-ledger.json', rows);
      }
      if (mutation === 'ledger_growth')
        f.write('pg-settled-ledger.json', f.artifacts['pg-runtime-ledger.json']);
      if (mutation === 'arguments')
        f.write('settlement-arguments.json', { t: f.h.context.tenantId });
      expect(() => f.run('settled')).toThrow();
    } finally {
      f.cleanup();
    }
  });
});
