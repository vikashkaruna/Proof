import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
/** Pure, unmounted v2 settlement guard. Receipt witnesses must be loaded
 * independently from actual retained ledger rows. Caller envelopes, matching
 * hashes and synthetic tests never establish custody or invocation authority. */
import { z } from 'zod';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { canonicalJson } from '@axiom/ledger';
import {
  PRATIVEDAN_RENDERER_AGENT_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  prativedanAssessmentDraftOutputSchema,
  prativedanAssessmentRendererInputSchema,
  prativedanLedgerReceiptSchema,
  type PrativedanAssessmentDraftOutput,
} from '@axiom/types';
import { prativedanFixedDecimal } from './prativedan-decimal.js';
import {
  preparePrativedanAssessmentDraftSource,
  type PreparedPrativedanAssessmentDraftSource,
} from './prativedan-assessment-draft-source.js';
import { prativedanTextHash, PrativedanDraftRefused } from './prativedan-draft-source.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const bytes = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine(
      (value) =>
        !value.includes('\0') &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
        new TextEncoder().encode(value).byteLength <= limit,
    );
const binding = {
  schema_version: z.literal(2),
  tenant_id: uuid,
  engagement_id: uuid,
  source_id: uuid,
  assessment_run_id: uuid,
  run_id: uuid,
  operation_key: uuid,
  source_sha256: hash,
  request_sha256: hash,
  runtime_normalized_input_sha256: hash,
  runtime_output_sha256: hash,
  renderer_config_version: z.literal(PRATIVEDAN_RENDERER_CONFIG_VERSION),
  renderer_config_sha256: z.literal(PRATIVEDAN_RENDERER_CONFIG_SHA256),
  agent: z.literal('prativedan'),
  agent_version: z.literal(PRATIVEDAN_RENDERER_AGENT_VERSION),
  correlation_id: uuid,
  target_ref: uuid,
  requested_receipt: prativedanLedgerReceiptSchema,
  claimed_receipt: prativedanLedgerReceiptSchema,
  started_receipt: prativedanLedgerReceiptSchema,
  completed_receipt: prativedanLedgerReceiptSchema,
  claim_expires_at: stamp,
  completed_at: stamp,
};
/** Prospective v2 runtime wire shape; no transport is mounted by this module. */
export const prativedanAssessmentRuntimeEnvelopeSchema = z
  .object({
    ...binding,
    renderer_config_text: z.literal(PRATIVEDAN_RENDERER_CONFIG_TEXT),
    normalized_input_text: bytes(1048576),
    runtime_output_text: bytes(2097152),
    output: prativedanAssessmentDraftOutputSchema,
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
  })
  .strict();
/** Independently supplied trusted loader data, never derived from the envelope. */
export const prativedanAssessmentRuntimeReceiptWitnessSchema = z.object(binding).strict();

function instant(value: string): bigint {
  const match =
    /^(.*T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match) throw new PrativedanDraftRefused();
  return (
    BigInt(Date.parse(match[1]! + match[3]!) / 1000) * 1000000000n +
    BigInt((match[2] ?? '').padEnd(9, '0'))
  );
}
function summary(input: PreparedPrativedanAssessmentDraftSource['rendererInput']) {
  const score = input.posture_score;
  const band =
    score >= 85 ? 'Strong' : score >= 65 ? 'Acceptable' : score >= 40 ? 'At Risk' : 'Critical';
  const posture = `${prativedanFixedDecimal(score, 0)}/100 (${band}; provisional)`;
  return {
    posture,
    body: `Declared posture score: ${posture}. Estimated statutory exposure (provisional): ₹${prativedanFixedDecimal(input.estimated_exposure_inr / 10000000, 2)} Cr. ${input.findings.length} findings included for review. Library version: ${input.library_version}.`,
  };
}
function verifySections(
  prepared: PreparedPrativedanAssessmentDraftSource,
  output: PrativedanAssessmentDraftOutput,
) {
  const input = prepared.rendererInput;
  const projection = summary(input);
  const expected = [
    { type: 'executive_summary', title: 'Executive summary', body: projection.body },
    {
      type: 'findings_table',
      title: 'Findings for review (source order)',
      items: input.findings.slice(0, 10).map((item) => ({ ...item, risk_points: null })),
    },
    {
      type: 'library',
      title: 'Control library',
      body: `Referenced library version: ${input.library_version}. Draft input declares ${input.library_control_ids.length} controls; frozen source verification remains required.`,
    },
    {
      type: 'attribution',
      title: 'Draft attribution and review status',
      body: `Generated by Prativedan (v${PRATIVEDAN_RENDERER_AGENT_VERSION}). Pending recorded human review. Evidence references are unverified.`,
    },
  ];
  if (output.title !== input.title || canonicalJson(output.sections) !== canonicalJson(expected))
    throw new PrativedanDraftRefused();
  return projection.posture;
}
type Node = DefaultTreeAdapterMap['node'];
const allowed = new Set([
  'h1',
  'div',
  'p',
  'strong',
  'h2',
  'table',
  'thead',
  'tr',
  'th',
  'tbody',
  'td',
]);
function inspect(node: Node): void {
  if ('tagName' in node) {
    if (
      !allowed.has(node.tagName) ||
      node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      node.attrs.some(
        (a) => node.tagName !== 'div' || a.name !== 'class' || a.value !== 'axiom-cover',
      )
    )
      throw new PrativedanDraftRefused();
  } else if (node.nodeName !== '#text' && node.nodeName !== '#document-fragment')
    throw new PrativedanDraftRefused();
  if ('childNodes' in node) node.childNodes.forEach(inspect);
}
function nodeText(node: Node): string {
  return '#text' === node.nodeName && 'value' in node
    ? node.value
    : 'childNodes' in node
      ? node.childNodes.map(nodeText).join('')
      : '';
}
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
interface HtmlShape {
  tag: string;
  attributes: { name: string; value: string }[];
  children: HtmlShape[];
  text?: string;
}
function tree(node: Node): HtmlShape {
  if (node.nodeName === '#text' && 'value' in node)
    return { tag: '#text', attributes: [], children: [], text: node.value };
  return {
    tag: 'tagName' in node ? node.tagName : node.nodeName,
    attributes: 'attrs' in node ? node.attrs.map(({ name, value }) => ({ name, value })) : [],
    children:
      'childNodes' in node
        ? node.childNodes
            .filter(
              (n) =>
                node.nodeName !== '#document-fragment' ||
                n.nodeName !== '#text' ||
                nodeText(n).trim(),
            )
            .map(tree)
        : [],
  };
}
function verifyHtml(output: PrativedanAssessmentDraftOutput, posture: string): void {
  const parsed = parseFragment(output.rendered_html);
  inspect(parsed);
  const rows: Node[] = [];
  const collect = (node: Node) => {
    if ('tagName' in node && node.tagName === 'tr') rows.push(node);
    if ('childNodes' in node) node.childNodes.forEach(collect);
  };
  collect(parsed);
  const findings = output.sections[1].items;
  if (rows.length !== findings.length + 1) throw new PrativedanDraftRefused();
  const scoreTexts: string[] = [];
  rows.slice(1).forEach((row, index) => {
    if (!('childNodes' in row)) throw new PrativedanDraftRefused();
    const cells = row.childNodes.filter((node) => 'tagName' in node);
    const score = cells[3] ? nodeText(cells[3]) : '';
    if (
      cells.length !== 5 ||
      !/^-?(?:[0-9]+(?:\.[0-9]+)?)(?:e[+-]?[0-9]+)?$/i.test(score) ||
      Number(score) !== findings[index]!.score
    )
      throw new PrativedanDraftRefused();
    scoreTexts.push(score);
  });
  const parts = [
    `<h1>${escape(output.title)}</h1>`,
    `<div class="axiom-cover"><p>Posture: <strong>${escape(posture)}</strong></p></div>`,
  ];
  output.sections.forEach((section) => {
    parts.push(`<h2>${escape(section.title)}</h2>`);
    if ('body' in section) parts.push(`<p>${escape(section.body)}</p>`);
    else
      parts.push(
        '<table><thead><tr><th>Control</th><th>Title</th><th>Severity</th><th>Score</th><th>Risk pts</th></tr></thead><tbody>' +
          section.items
            .map(
              (item, index) =>
                `<tr><td>${escape(item.control_id)}</td><td>${escape(item.title)}</td><td>${escape(item.severity)}</td><td>${escape(scoreTexts[index]!)}</td><td></td></tr>`,
            )
            .join('') +
          '</tbody></table>',
      );
  });
  if (canonicalJson(tree(parsed)) !== canonicalJson(tree(parseFragment(parts.join('\n')))))
    throw new PrativedanDraftRefused();
}

/** Pure rendering fidelity only: this accepts no runtime receipt proof and
 * grants no claim, invocation, settlement, release or publication authority. */
export function verifyPrativedanAssessmentRendering(
  prepared: PreparedPrativedanAssessmentDraftSource,
  rawOutput: unknown,
): PrativedanAssessmentDraftOutput {
  try {
    prepared = preparePrativedanAssessmentDraftSource(
      prepared.journal,
      prepared.reviewedRequestText,
    );
    const output = prativedanAssessmentDraftOutputSchema.parse(rawOutput);
    const posture = verifySections(prepared, output);
    verifyHtml(output, posture);
    return output;
  } catch {
    throw new PrativedanDraftRefused();
  }
}

export function verifyPrativedanAssessmentDraftOutput(
  prepared: PreparedPrativedanAssessmentDraftSource,
  rawEnvelope: unknown,
  rawIndependentReceiptWitness: unknown,
) {
  try {
    prepared = preparePrativedanAssessmentDraftSource(
      prepared.journal,
      prepared.reviewedRequestText,
    );
    const journal = prepared.journal;
    if (journal.state === 'requested') throw new PrativedanDraftRefused();
    const envelope = prativedanAssessmentRuntimeEnvelopeSchema.parse(rawEnvelope);
    const witness = prativedanAssessmentRuntimeReceiptWitnessSchema.parse(
      rawIndependentReceiptWitness,
    );
    for (const key of Object.keys(binding) as (keyof typeof binding)[])
      if (canonicalJson(envelope[key]) !== canonicalJson(witness[key]))
        throw new PrativedanDraftRefused();
    const ids = [
      prepared.source.receipts.finalized.id,
      journal.requested_receipt.id,
      journal.claimed_receipt.id,
      witness.started_receipt.id,
      witness.completed_receipt.id,
    ];
    if (
      !ids.every((id, index) => index === 0 || BigInt(ids[index - 1]!) < BigInt(id)) ||
      envelope.tenant_id !== journal.tenant_id ||
      envelope.engagement_id !== journal.engagement_id ||
      envelope.source_id !== journal.source_id ||
      envelope.assessment_run_id !== journal.assessment_run_id ||
      envelope.run_id !== journal.run_id ||
      envelope.operation_key !== journal.operation_key ||
      envelope.correlation_id !== journal.operation_key ||
      envelope.target_ref !== journal.engagement_id ||
      envelope.source_sha256 !== journal.source_sha256 ||
      envelope.request_sha256 !== journal.request_sha256 ||
      canonicalJson(envelope.requested_receipt) !== canonicalJson(journal.requested_receipt) ||
      canonicalJson(envelope.claimed_receipt) !== canonicalJson(journal.claimed_receipt) ||
      envelope.claim_expires_at !== journal.claim_expires_at ||
      instant(witness.completed_at) > instant(journal.claim_expires_at) ||
      envelope.normalized_input_text !== journal.normalized_input_text ||
      prativedanTextHash(envelope.normalized_input_text) !==
        journal.runtime_normalized_input_sha256 ||
      envelope.runtime_normalized_input_sha256 !== journal.runtime_normalized_input_sha256 ||
      prativedanTextHash(envelope.runtime_output_text) !== witness.runtime_output_sha256
    )
      throw new PrativedanDraftRefused();
    const input = prativedanAssessmentRendererInputSchema.parse(
      parsePrativedanAssessmentJson(envelope.normalized_input_text),
    );
    const output = prativedanAssessmentDraftOutputSchema.parse(
      parsePrativedanAssessmentJson(envelope.runtime_output_text),
    );
    if (
      canonicalJson(input) !== canonicalJson(prepared.rendererInput) ||
      canonicalJson(output) !== canonicalJson(envelope.output)
    )
      throw new PrativedanDraftRefused();
    verifyPrativedanAssessmentRendering(prepared, output);
    const responseOutputText = canonicalJson(output);
    const responseOutputSha256 = prativedanTextHash(responseOutputText);
    if (
      journal.state === 'unpublished' &&
      (journal.runtime_output_text !== envelope.runtime_output_text ||
        journal.runtime_output_sha256 !== witness.runtime_output_sha256 ||
        canonicalJson(journal.output) !== canonicalJson(output) ||
        prativedanTextHash(journal.response_output_text) !== journal.response_output_sha256 ||
        journal.response_output_text !== responseOutputText ||
        journal.response_output_sha256 !== responseOutputSha256 ||
        canonicalJson(parsePrativedanAssessmentJson(journal.response_output_text)) !==
          canonicalJson(output) ||
        canonicalJson(journal.started_receipt) !== canonicalJson(witness.started_receipt) ||
        canonicalJson(journal.completed_receipt) !== canonicalJson(witness.completed_receipt))
    )
      throw new PrativedanDraftRefused();
    return {
      output,
      responseOutputText,
      responseOutputSha256,
      sourceSha256: journal.source_sha256,
      requestSha256: journal.request_sha256,
      runtimeNormalizedInputSha256: journal.runtime_normalized_input_sha256,
      runtimeOutputSha256: witness.runtime_output_sha256,
      rendererConfigVersion: envelope.renderer_config_version,
      rendererConfigSha256: envelope.renderer_config_sha256,
    };
  } catch {
    throw new PrativedanDraftRefused();
  }
}
