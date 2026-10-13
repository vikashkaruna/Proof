/** Synthetic Python/TypeScript interoperability only; no mounted workflow or DB proof. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  prativedanDraftRequestSchema,
  prativedanFrozenSourceSchema,
  prativedanSourceWitnessSchema,
  prativedanRendererInputSchema,
  prativedanRuntimeEnvelopeSchema,
  prativedanReceiptWitnessSchema,
  prativedanDraftReadbackProofSchema,
  prativedanRecordedDispatchSchema,
  prativedanDispatchClaimSchema,
  prativedanRendererConfigSchema,
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
} from '@axiom/types';
import { preparePrativedanDraftSource, prativedanTextHash } from './prativedan-draft-source.js';
import { verifyPrativedanDraftOutput } from './prativedan-draft-output.js';

const fixtureSchema = z
  .object({
    schema_version: z.literal(1),
    synthetic: z.literal(true),
    live_workflow_acceptance: z.literal(false),
    python_version: z.string().regex(/^3\.14\./),
    cases: z
      .array(
        z
          .object({
            name: z.string().min(1),
            request: prativedanDraftRequestSchema,
            source_witness: prativedanSourceWitnessSchema,
            dispatch: prativedanRecordedDispatchSchema,
            claim_witness: prativedanDispatchClaimSchema,
            actual_runtime_receipt_details: z
              .array(
                z
                  .object({
                    phase: z.enum(['started', 'completed']),
                    run_id: z.uuidv4(),
                    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
                    renderer_config_version: z.literal(PRATIVEDAN_RENDERER_CONFIG_VERSION),
                    renderer_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
                    started_entry: z
                      .string()
                      .regex(/^[1-9][0-9]*$/)
                      .optional(),
                  })
                  .strict(),
              )
              .length(2),
            envelope: prativedanRuntimeEnvelopeSchema,
            receipt_witness: prativedanReceiptWitnessSchema,
            readback_proof: prativedanDraftReadbackProofSchema,
            response_output_text: z.string(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../tests/contracts/prativedan-draft.v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
type Case = (typeof fixture.cases)[number];
const domains = [
  'source_sha256',
  'request_sha256',
  'runtime_normalized_input_sha256',
  'runtime_output_sha256',
  'response_output_sha256',
  'renderer_config_sha256',
] as const;

function verifyReadback(testCase: Case, rawProof: unknown) {
  const proof = prativedanDraftReadbackProofSchema.parse(rawProof);
  const prepared = preparePrativedanDraftSource(testCase.source_witness, testCase.request);
  const verified = verifyPrativedanDraftOutput(
    prepared,
    testCase.envelope,
    testCase.receipt_witness,
  );
  const expectedDomains = {
    source_sha256: prativedanTextHash(testCase.source_witness.source_text),
    request_sha256: prativedanTextHash(proof.request_text),
    runtime_normalized_input_sha256: prativedanTextHash(proof.normalized_input_text),
    runtime_output_sha256: prativedanTextHash(proof.runtime_output_text),
    response_output_sha256: prativedanTextHash(canonicalJson(proof.output)),
    renderer_config_sha256: prativedanTextHash(proof.renderer_config_text),
  };
  for (const domain of domains) expect(proof[domain]).toBe(expectedDomains[domain]);
  expect(proof.request_text).toBe(prepared.requestText);
  expect(proof.request_text).toBe(testCase.dispatch.request_text);
  expect(proof.normalized_input_text).toBe(testCase.envelope.normalized_input_text);
  expect(proof.runtime_output_text).toBe(testCase.envelope.runtime_output_text);
  expect(proof.response_output_sha256).toBe(verified.responseOutputSha256);
  expect(proof.renderer_config_text).toBe(PRATIVEDAN_RENDERER_CONFIG_TEXT);
  expect(proof.renderer_config_text).toBe(testCase.envelope.renderer_config_text);
  expect(proof.renderer_config_sha256).toBe(PRATIVEDAN_RENDERER_CONFIG_SHA256);
  expect(proof.renderer_config_version).toBe(PRATIVEDAN_RENDERER_CONFIG_VERSION);
  expect(canonicalJson(proof.output)).toBe(verified.responseOutputText);
  expect(canonicalJson(JSON.parse(proof.runtime_output_text))).toBe(canonicalJson(proof.output));
  return proof;
}

describe('actual synthetic Python 3.14 Prativedan byte contracts', () => {
  it.each(fixture.cases)(
    'rehashes five byte domains, renderer identity and source projections: $name',
    (testCase) => {
      const frozen = prativedanFrozenSourceSchema.parse(
        JSON.parse(testCase.source_witness.source_text),
      );
      expect(prativedanTextHash(frozen.controls_text)).toBe(frozen.controls_sha256);
      expect(prativedanTextHash(frozen.result_text)).toBe(frozen.result_sha256);
      expect(prativedanTextHash(testCase.dispatch.request_text)).toBe(
        testCase.dispatch.request_sha256,
      );
      const prepared = preparePrativedanDraftSource(testCase.source_witness, testCase.request);
      const normalized = prativedanRendererInputSchema.parse(
        JSON.parse(testCase.envelope.normalized_input_text),
      );
      expect(canonicalJson(normalized)).toBe(canonicalJson(prepared.rendererInput));
      const retained = verifyReadback(testCase, testCase.readback_proof);
      expect(testCase.response_output_text).toBe(canonicalJson(retained.output));
      expect(retained.state).toBe('unpublished');
      expect(retained.review_required).toBe(true);
      expect(retained.publication_allowed).toBe(false);
      expect(
        prativedanRendererConfigSchema.parse(JSON.parse(retained.renderer_config_text))
          .model_inference,
      ).toBe(false);
      expect(
        prativedanRendererConfigSchema.parse(JSON.parse(retained.renderer_config_text))
          .model_identity,
      ).toBeNull();
      for (const binding of [
        testCase.dispatch,
        testCase.claim_witness,
        testCase.envelope,
        testCase.receipt_witness,
        ...testCase.actual_runtime_receipt_details,
      ]) {
        expect(binding.renderer_config_version).toBe(PRATIVEDAN_RENDERER_CONFIG_VERSION);
        expect(binding.renderer_config_sha256).toBe(PRATIVEDAN_RENDERER_CONFIG_SHA256);
      }
      expect(testCase.actual_runtime_receipt_details.map((row) => row.phase)).toEqual([
        'started',
        'completed',
      ]);
      expect(testCase.actual_runtime_receipt_details[1]!.started_entry).toBe(
        testCase.envelope.started_receipt.id,
      );
    },
  );

  it('includes actual Unicode/HTML-sensitive/fractional/large safe integer coverage', () => {
    const inputs = fixture.cases.map((testCase) =>
      prativedanRendererInputSchema.parse(JSON.parse(testCase.envelope.normalized_input_text)),
    );
    expect(inputs.some((input) => input.estimated_exposure_inr === Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
    expect(
      inputs.some(
        (input) => input.posture_score !== null && !Number.isInteger(input.posture_score),
      ),
    ).toBe(true);
    expect(
      inputs.some((input) => /[\u0900-\u097f]/u.test(input.title) && input.title.includes('<')),
    ).toBe(true);
    expect(
      fixture.cases.some((testCase) => testCase.envelope.output.rendered_html.includes('&lt;')),
    ).toBe(true);
    expect(
      fixture.cases.some(
        (testCase) =>
          testCase.envelope.runtime_output_sha256 !==
          testCase.readback_proof.response_output_sha256,
      ),
    ).toBe(true);
  });

  it.each(fixture.cases)(
    'refuses all domain substitutions and hash-only readback: $name',
    (testCase) => {
      for (const domain of domains) {
        const changed = structuredClone(testCase.readback_proof);
        const foreignDomain = domains.find((other) => changed[other] !== changed[domain]);
        expect(foreignDomain).toBeDefined();
        changed[domain] = changed[foreignDomain!];
        expect(() => verifyReadback(testCase, changed)).toThrow();
      }
      for (const key of ['normalized_input_text', 'runtime_output_text', 'renderer_config_text']) {
        const hashOnly: Record<string, unknown> = { ...testCase.readback_proof };
        delete hashOnly[key];
        expect(() => verifyReadback(testCase, hashOnly)).toThrow();
      }
    },
  );

  it.each(fixture.cases)(
    'refuses an altered runtime output with recomputed self-declared hashes: $name',
    (testCase) => {
      const changed = structuredClone(testCase.envelope);
      changed.output.sections[0].body = 'Verified legal approval';
      changed.runtime_output_text = canonicalJson(changed.output);
      changed.runtime_output_sha256 = prativedanTextHash(changed.runtime_output_text);
      const prepared = preparePrativedanDraftSource(testCase.source_witness, testCase.request);
      expect(() =>
        verifyPrativedanDraftOutput(prepared, changed, testCase.receipt_witness),
      ).toThrow('contract_refused');
    },
  );

  it('refuses TS reserialization of actual Python bytes against the original completion receipt', () => {
    const testCase = fixture.cases.find(
      (row) => row.envelope.runtime_output_sha256 !== row.readback_proof.response_output_sha256,
    );
    expect(testCase).toBeDefined();
    const changed = structuredClone(testCase!.envelope);
    changed.runtime_output_text = canonicalJson(changed.output);
    changed.runtime_output_sha256 = prativedanTextHash(changed.runtime_output_text);
    const prepared = preparePrativedanDraftSource(testCase!.source_witness, testCase!.request);
    expect(() => verifyPrativedanDraftOutput(prepared, changed, testCase!.receipt_witness)).toThrow(
      'contract_refused',
    );
  });

  it.each(fixture.cases)(
    'refuses changed config with recomputed self-consistent envelope and receipt hashes: $name',
    (testCase) => {
      const changed = structuredClone(testCase.envelope);
      const witness = structuredClone(testCase.receipt_witness);
      const alteredManifest = JSON.parse(changed.renderer_config_text);
      alteredManifest.model_inference = true;
      changed.renderer_config_text = canonicalJson(alteredManifest);
      changed.renderer_config_sha256 = prativedanTextHash(changed.renderer_config_text);
      witness.renderer_config_sha256 = changed.renderer_config_sha256;
      const prepared = preparePrativedanDraftSource(testCase.source_witness, testCase.request);
      expect(() => verifyPrativedanDraftOutput(prepared, changed, witness)).toThrow(
        'contract_refused',
      );
    },
  );
});
