import test from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  acceptancePublicWebsiteCapture,
  publicControlAcceptanceFailure,
  verifyPublicSourceCompletionReceipt,
} from './acceptance-public-control-source.js';
import { bindPublicEvidenceV2 } from '../../services/bff/src/connectors/public-evidence-codec-v2.js';
import { evaluatePublicEvidenceV2 } from '../../services/bff/src/connectors/public-evidence-evaluator-v2.js';
import { PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT } from '../../packages/control-library/src/index.js';
import { validateFreshPublicCapture } from '../../services/bff/src/connectors/public-capture-validation-v2.js';

test('synthetic transport exercises real extraction and hash-validated capture', async () => {
  const captured = await acceptancePublicWebsiteCapture(
    'https://fixture.axiomproof.ai/',
    AbortSignal.timeout(5000),
  );
  assert.equal(validateFreshPublicCapture(captured), true);
  assert.equal(captured.check.finalUrl, 'https://fixture.axiomproof.ai/');
  assert.equal(captured.evidence.pageSources.find((p) => p.page === 'privacy')?.state, 'examined');
  assert.equal(
    createHash('sha256').update(captured.evidence.payloadText).digest('hex'),
    captured.evidence.payloadSha256,
  );
  assert(captured.evidence.payloadText.includes('privacy_notice'));
});
test('fixture transport retains production URL rejection for local addresses', async () => {
  await assert.rejects(
    acceptancePublicWebsiteCapture('http://127.0.0.1/', AbortSignal.timeout(5000)),
  );
});
test('fixture does not silently capture an unrelated public host', async () => {
  await assert.rejects(
    acceptancePublicWebsiteCapture('https://unrelated.org/', AbortSignal.timeout(5000)),
  );
});

test('diagnostics omit assertion values and raw error messages', () => {
  const secret = 'synthetic-private-value';
  let failure: unknown;
  try {
    assert.equal(secret, 'other');
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(publicControlAcceptanceFailure(failure), { kind: 'assertion', path: [] });
  assert.deepEqual(publicControlAcceptanceFailure(new Error(secret)), { kind: 'error', path: [] });
  assert(!JSON.stringify(publicControlAcceptanceFailure(failure)).includes(secret));
});
test('schema diagnostics allow only fixed field labels and redact unknown paths', () => {
  const parsed = z.object({ secretField: z.string() }).safeParse({ secretField: 42 });
  assert(!parsed.success);
  assert.deepEqual(publicControlAcceptanceFailure(parsed.error), {
    kind: 'schema',
    path: ['field'],
  });
});

test('registered fixture supplies bounded privacy/contact/terms/consent substance and preserves qualified demo consent', async () => {
  const oldMode = process.env.AXIOM_REGISTERED_WEBSITE_BROWSER;
  const oldReports = process.env.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE;
  process.env.AXIOM_REGISTERED_WEBSITE_BROWSER = 'true';
  process.env.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE = 'true';
  try {
    const value = await acceptancePublicWebsiteCapture(
      'https://fixture.axiomproof.ai/',
      AbortSignal.timeout(5000),
    );
    assert.equal(validateFreshPublicCapture(value), true);
    const payload = JSON.parse(value.evidence.payloadText) as {
      pages: Array<{ page: string; state: string }>;
      candidates: Array<{
        facet: string;
        context: string;
        locator: { page: string };
        excerpt: string;
      }>;
    };
    assert.deepEqual(
      payload.pages.map((p) => p.page),
      ['root', 'privacy', 'contact', 'terms', 'consent'],
    );
    assert(payload.pages.every((p) => p.state === 'examined'));
    for (const page of ['privacy', 'contact', 'terms', 'consent'])
      assert(payload.candidates.some((c) => c.locator.page === page));
    assert(
      payload.candidates.some(
        (c) => c.locator.page === 'terms' && c.facet === 'processor_disclosure',
      ),
    );
    assert(payload.candidates.some((c) => c.facet === 'consent_ui' && c.context === 'demo'));
    assert(!value.evidence.payloadText.includes('compliant'));
    const source = bindPublicEvidenceV2(payload, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      engagementId: '22222222-2222-4222-8222-222222222222',
      checkId: '33333333-3333-4333-8333-333333333333',
      assessmentDate: '2026-10-16',
    }).source;
    const manifest = PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT;
    const sha = createHash('sha256').update(manifest).digest('hex');
    const evaluated = evaluatePublicEvidenceV2(
      { source, catalogueManifestText: manifest, catalogueManifestSha256: sha },
      { text: manifest, sha256: sha },
    );
    assert.equal(evaluated.controls.length, 46);
    for (const page of ['privacy', 'terms', 'contact', 'consent']) {
      const ordinals = evaluated.source.candidates
        .filter((c) => c.locator.page === page)
        .map((c) => c.ordinal);
      assert(
        evaluated.controls.some((c) =>
          c.questions.some((q) => q.evidence.candidateOrdinals.some((n) => ordinals.includes(n))),
        ),
        'fixture substance must map to actual control questions',
      );
    }
    assert(
      evaluated.controls.some((c) =>
        c.questions.some((q) => q.evidence.state === 'internal_unknown'),
      ),
    );
  } finally {
    if (oldMode === undefined) delete process.env.AXIOM_REGISTERED_WEBSITE_BROWSER;
    else process.env.AXIOM_REGISTERED_WEBSITE_BROWSER = oldMode;
    if (oldReports === undefined) delete process.env.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE;
    else process.env.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE = oldReports;
  }
});

for (const [agent, action] of [
  ['drishti', 'discovery.started'],
  ['vibhaag', 'classification.started'],
] as const)
  test(`accepts actual immutable SQL public-source completion contract for ${agent}`, () => {
    const expected = {
      agent,
      engagementId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      correlationId: '33333333-3333-4333-8333-333333333333',
      requestHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
    };
    const receipt = {
      actor_type: 'agent',
      actor_id: agent,
      action_type: action,
      result: 'success',
      target_ref: expected.engagementId,
      correlation_id: expected.correlationId,
      input_hash: expected.requestHash,
      output_hash: expected.outputHash,
      detail: { phase: 'completed', run_id: expected.runId, request_hash: expected.requestHash },
    };
    verifyPublicSourceCompletionReceipt(receipt, expected);
    for (const patch of [
      { action_type: 'agent.completed' },
      { action_type: agent === 'drishti' ? 'classification.started' : 'discovery.started' },
      { actor_type: 'human' },
      { actor_id: 'other-agent' },
      { result: 'failure' },
      { target_ref: expected.runId },
      { correlation_id: expected.runId },
      { input_hash: 'c'.repeat(64) },
      { output_hash: 'c'.repeat(64) },
      { detail: { ...receipt.detail, phase: 'started' } },
      { detail: { ...receipt.detail, run_id: expected.engagementId } },
      { detail: { ...receipt.detail, request_hash: 'c'.repeat(64) } },
    ])
      assert.throws(() => verifyPublicSourceCompletionReceipt({ ...receipt, ...patch }, expected));
  });

test('completion fixture matches immutable SQL0106 action and completed-phase contract', () => {
  const sql = readFileSync(
    'infra/supabase/migrations/0106_public_source_agent_observations.sql',
    'utf8',
  );
  assert(
    sql.includes(
      "case d.agent when 'drishti' then 'discovery.started' else 'classification.started' end",
    ),
  );
  assert(sql.includes("c.detail->>'phase' is distinct from 'completed'"));
  assert(sql.includes("c.detail->>'run_id' is distinct from p_run_id::text"));
  assert(sql.includes('c.correlation_id is distinct from r.correlation_id'));
  assert(sql.includes('c.input_hash is distinct from d.request_hash'));
  assert(sql.includes('c.output_hash is distinct from digest'));
});
