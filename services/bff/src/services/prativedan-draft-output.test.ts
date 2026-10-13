import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { outputFixture } from './prativedan-draft.test-fixture.js';
import { prativedanTextHash } from './prativedan-draft-source.js';
import { verifyPrativedanDraftOutput } from './prativedan-draft-output.js';

describe('unmounted Prativedan output receipt boundary', () => {
  it('verifies exact trusted runtime bytes while preserving separate TS response hash', () => {
    const f = outputFixture();
    const result = verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness);
    expect(result.responseOutputText).toBe(f.responseText);
    expect(result.responseOutputSha256).not.toBe(result.runtimeOutputSha256);
    expect(result.output.review_required).toBe(true);
    expect(result.output.cited_evidence_ids).toEqual([]);
  });
  it.each(['input', 'output', 'escaped-output', 'nested-output'])(
    'refuses ambiguous JSON bytes even when trusted hash witnesses match: %s',
    (mode) => {
      const f = outputFixture();
      if (mode === 'input') {
        f.envelope.normalized_input_text = f.envelope.normalized_input_text.replace(
          '"posture_score":',
          '"posture_score":100,"posture_score":',
        );
        f.envelope.runtime_normalized_input_sha256 = prativedanTextHash(
          f.envelope.normalized_input_text,
        );
        f.witness.runtime_normalized_input_sha256 = f.envelope.runtime_normalized_input_sha256;
      } else {
        if (mode === 'output')
          f.envelope.runtime_output_text = f.envelope.runtime_output_text.replace(
            '"review_required":',
            '"review_required":false,"review_required":',
          );
        if (mode === 'escaped-output')
          f.envelope.runtime_output_text = f.envelope.runtime_output_text.replace(
            '"review_required":',
            '"review_\\u0072equired":false,"review_required":',
          );
        if (mode === 'nested-output')
          f.envelope.runtime_output_text = f.envelope.runtime_output_text.replace(
            '"severity":',
            '"severity":"low","severity":',
          );
        f.envelope.runtime_output_sha256 = prativedanTextHash(f.envelope.runtime_output_text);
        f.witness.runtime_output_sha256 = f.envelope.runtime_output_sha256;
      }
      expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow(
        'contract_refused',
      );
    },
  );
  it('binds the reviewed renderer manifest independently of five byte commitments', () => {
    const f = outputFixture();
    const result = verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness);
    expect(result.rendererConfigSha256).toBe(f.prepared.rendererConfigSha256);
    expect(prativedanTextHash(f.envelope.renderer_config_text)).toBe(result.rendererConfigSha256);
    expect(result.rendererConfigVersion).toBe(f.prepared.rendererConfigVersion);
  });
  it.each([
    'bytes',
    'behavior',
    'receipt',
    'agent-version',
    'cached-config',
    'config-version',
    'domain-substitution',
  ])('refuses renderer configuration mutation: %s', (mode) => {
    const f = outputFixture();
    if (mode === 'bytes') f.envelope.renderer_config_text += ' ';
    if (mode === 'behavior')
      f.envelope.renderer_config_text = f.envelope.renderer_config_text.replace(
        '"finding_limit":10',
        '"finding_limit":1',
      );
    if (mode === 'bytes' || mode === 'behavior') {
      f.envelope.renderer_config_sha256 = prativedanTextHash(f.envelope.renderer_config_text);
      f.witness.renderer_config_sha256 = f.envelope.renderer_config_sha256;
    }
    if (mode === 'config-version') {
      const envelope: Record<string, unknown> = f.envelope;
      const witness: Record<string, unknown> = f.witness;
      envelope.renderer_config_version = 'unreviewed-v2';
      witness.renderer_config_version = 'unreviewed-v2';
    }
    if (mode === 'domain-substitution') {
      f.envelope.renderer_config_sha256 = f.envelope.source_sha256;
      f.witness.renderer_config_sha256 = f.envelope.source_sha256;
    }
    if (mode === 'receipt') f.witness.renderer_config_sha256 = 'f'.repeat(64);
    if (mode === 'agent-version') {
      f.envelope.agent_version = '9.9.9';
      f.witness.agent_version = '9.9.9';
    }
    if (mode === 'cached-config') {
      f.prepared.rendererConfigText = '{}';
      f.prepared.rendererConfigSha256 = prativedanTextHash('{}');
      f.envelope.renderer_config_text = '{}';
      f.envelope.renderer_config_sha256 = f.prepared.rendererConfigSha256;
      f.witness.renderer_config_sha256 = f.prepared.rendererConfigSha256;
    }
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
  });
  it('requires exact completed output bytes even for a semantics-preserving transport rewrite', () => {
    const f = outputFixture();
    f.envelope.runtime_output_text += ' ';
    f.envelope.runtime_output_sha256 = prativedanTextHash(f.envelope.runtime_output_text);
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
  });
  it('refuses altered output and recomputed transport digest against original completed receipt', () => {
    const f = outputFixture();
    f.envelope.output.sections[0].body = 'Verified compliance';
    f.envelope.runtime_output_text = JSON.stringify(f.envelope.output);
    f.envelope.runtime_output_sha256 = prativedanTextHash(f.envelope.runtime_output_text);
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow(
      'contract_refused',
    );
  });
  it.each([
    'title',
    'findings',
    'library',
    'review',
    'citation',
    'html',
    'html-source',
    'summary',
    'ranking',
  ])('refuses source/semantic mutation even with self-consistent hashes: %s', (mode) => {
    const f = outputFixture();
    const output: Record<string, unknown> = f.envelope.output;
    if (mode === 'title') f.envelope.output.title = 'foreign';
    if (mode === 'findings') f.envelope.output.sections[1].items[0]!.rationale = 'verified';
    if (mode === 'ranking')
      f.envelope.output.sections[1].title = 'Top findings (by risk-weighted exposure)';
    if (mode === 'library') f.envelope.output.sections[2].body = 'All controls certified';
    if (mode === 'review') output.review_required = false;
    if (mode === 'citation') output.cited_evidence_ids = [f.envelope.run_id];
    if (mode === 'html') f.envelope.output.rendered_html += '<script>alert(1)</script>';
    if (mode === 'html-source')
      f.envelope.output.rendered_html = f.envelope.output.rendered_html.replace(
        'संरक्षण &lt;review&gt;',
        'Foreign control',
      );
    if (mode === 'summary')
      f.envelope.output.sections[0].body = f.envelope.output.sections[0].body.replace(
        '₹0.01',
        '₹99.00',
      );
    f.envelope.runtime_output_text = JSON.stringify(f.envelope.output);
    f.envelope.runtime_output_sha256 = prativedanTextHash(f.envelope.runtime_output_text);
    f.witness.runtime_output_sha256 = f.envelope.runtime_output_sha256;
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow(
      'contract_refused',
    );
  });
  it.each([
    'tenant',
    'run',
    'operation',
    'target',
    'version',
    'receipt',
    'request-hash',
    'source-hash',
    'order',
  ])('refuses altered envelope binding: %s', (mode) => {
    const f = outputFixture();
    if (mode === 'tenant') f.envelope.tenant_id = f.envelope.run_id;
    if (mode === 'run') f.envelope.run_id = f.envelope.tenant_id;
    if (mode === 'operation') f.envelope.operation_key = f.envelope.run_id;
    if (mode === 'target') f.envelope.target_ref = f.envelope.tenant_id;
    if (mode === 'version') f.envelope.agent_version = '9.9.9';
    if (mode === 'receipt')
      f.envelope.started_receipt = { ...f.envelope.started_receipt, entry_hash: 'f'.repeat(64) };
    if (mode === 'request-hash') f.envelope.request_sha256 = 'f'.repeat(64);
    if (mode === 'source-hash') f.envelope.source_sha256 = 'f'.repeat(64);
    if (mode === 'order') f.envelope.started_receipt = { ...f.envelope.started_receipt, id: '7' };
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow(
      'contract_refused',
    );
  });
  it('refuses changed normalized input, deleted defaults and cross-domain substitutions', () => {
    for (const mode of ['score', 'default', 'hash']) {
      const f = outputFixture();
      const input: Record<string, unknown> = JSON.parse(f.envelope.normalized_input_text);
      if (mode === 'score') input.posture_score = 0;
      if (mode === 'default') delete input.reviewer_id;
      f.envelope.normalized_input_text = canonicalJson(input);
      f.envelope.runtime_normalized_input_sha256 = prativedanTextHash(
        f.envelope.normalized_input_text,
      );
      f.witness.runtime_normalized_input_sha256 = f.envelope.runtime_normalized_input_sha256;
      if (mode === 'hash') f.envelope.runtime_output_sha256 = f.envelope.request_sha256;
      expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
    }
  });
  it('recomposes retained source rather than trusting a changed cached renderer input', () => {
    const f = outputFixture();
    f.prepared.rendererInput.posture_score = 0;
    f.envelope.normalized_input_text = canonicalJson(f.prepared.rendererInput);
    f.envelope.runtime_normalized_input_sha256 = prativedanTextHash(
      f.envelope.normalized_input_text,
    );
    f.witness.runtime_normalized_input_sha256 = f.envelope.runtime_normalized_input_sha256;
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
  });
  it('refuses a manufactured run ID as the runtime receipt target', () => {
    const f = outputFixture();
    f.envelope.target_ref = f.envelope.run_id;
    f.witness.target_ref = f.envelope.run_id;
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
  });
  it('refuses transport output structure differing from exact runtime text', () => {
    const f = outputFixture();
    f.envelope.output = { ...f.envelope.output, title: 'other title' };
    expect(() => verifyPrativedanDraftOutput(f.prepared, f.envelope, f.witness)).toThrow();
  });
});
