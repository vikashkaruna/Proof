/** Pure bounded static evidence candidates. No fetch, execution, model or legal decision. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DefaultTreeAdapterMap } from 'parse5';
import {
  publicControlPayloadV2Schema,
  type PublicControlPayloadV2,
  type PublicEvidenceFacetV2,
} from '@axiom/types';
import { parsePublicHtml } from './public-form-metadata.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pageKind = z.enum(['root', 'privacy', 'contact', 'terms', 'consent']);
const inputSchema = z
  .object({
    pages: z
      .array(
        z.discriminatedUnion('state', [
          z
            .object({
              page: pageKind,
              state: z.literal('examined'),
              html: z.instanceof(Uint8Array).refine((v) => v.byteLength <= 512 * 1024),
              contentSha256: digest,
            })
            .strict(),
          z.object({ page: pageKind, state: z.literal('unavailable') }).strict(),
          z.object({ page: pageKind, state: z.literal('unexamined') }).strict(),
        ]),
      )
      .min(1)
      .max(5),
  })
  .strict();
type Coverage = Pick<PublicControlPayloadV2['pages'][number], 'truncated' | 'coverageReasons'>;
function markCoverage(coverage: Coverage, reason: Coverage['coverageReasons'][number]) {
  coverage.truncated = true;
  if (!coverage.coverageReasons.includes(reason)) coverage.coverageReasons.push(reason);
}
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Candidate = PublicControlPayloadV2['candidates'][number];
type Context = Candidate['context'];
const isElement = (n: Node): n is Element =>
  'tagName' in n && n.namespaceURI === 'http://www.w3.org/1999/xhtml';
const attr = (n: Element, k: string) => n.attrs.find((a) => a.name === k)?.value;
const inert = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg']);
const controls = new Set(['input', 'select', 'textarea', 'button']);
const excludedInput = new Set(['hidden', 'password', 'file', 'submit', 'image', 'reset', 'button']);
function excluded(n: Element) {
  return (
    inert.has(n.tagName) ||
    attr(n, 'hidden') !== undefined ||
    attr(n, 'aria-hidden')?.toLowerCase() === 'true' ||
    /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(n, 'style') ?? '') ||
    (n.tagName === 'input' && excludedInput.has((attr(n, 'type') ?? 'text').toLowerCase()))
  );
}
function secret(value: string) {
  return /-----BEGIN|\bBearer\s|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]|\b(?:sk|pk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9+/=_-]{48,}/iu.test(
    value,
  );
}
function instruction(value: string) {
  return /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions|(?:system|assistant)\s*:\s|reveal\s+(?:the\s+)?(?:secret|token|password)|<\|(?:system|assistant)/iu.test(
    value,
  );
}
/** Redaction is conservative pattern filtering, not semantic name anonymization.
 * No downstream model egress is authorized by this text disposition. */
function clip(value: string, maximum: number): string {
  let end = Math.min(maximum, value.length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return value.slice(0, end);
}
function redact(value: string): string | undefined {
  if (secret(value) || instruction(value)) return undefined;
  const result = clip(
    value
      .replace(/https?:\/\/[^\s<>]+/giu, '[URL REDACTED]')
      .replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/gu, '[EMAIL REDACTED]')
      .replace(/\b(?:\+?\d[\d ()-]{6,}\d)\b/gu, '[NUMBER REDACTED]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[IP REDACTED]')
      .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gu, '[IDENTIFIER REDACTED]')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    512,
  );
  return result && !secret(result) ? result : undefined;
}
function text(root: Node, budget: Coverage, maximum = 1024): string {
  const stack = [root];
  const parts: string[] = [];
  let count = 0,
    length = 0;
  while (stack.length) {
    if (++count > 128 || length >= maximum) {
      markCoverage(budget, count > 128 ? 'text_node_budget' : 'text_length_budget');
      break;
    }
    const n = stack.pop()!;
    if ('tagName' in n && !isElement(n)) {
      markCoverage(budget, 'unsupported_foreign_markup');
      continue;
    }
    if (isElement(n) && (excluded(n) || controls.has(n.tagName))) continue;
    if (n.nodeName === '#text' && 'value' in n) {
      if (n.value.length > maximum - length) markCoverage(budget, 'text_length_budget');
      parts.push(clip(n.value, maximum - length));
      length += n.value.length;
    }
    if ('childNodes' in n)
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]!);
  }
  return clip(parts.join(' ').replace(/\s+/gu, ' ').trim(), maximum);
}
const facets: readonly [PublicEvidenceFacetV2, RegExp][] = [
  ['privacy_notice', /privacy|data protection|गोपनीयता/iu],
  ['entity', /\b(?:our company|company name|legal entity|data fiduciary)\b/iu],
  ['processor_disclosure', /\b(?:processor|service providers?|third.part(?:y|ies))\b/iu],
  ['notice_at_collection', /\b(?:before collecting|collection notice|at collection)\b/iu],
  ['withdrawal', /\b(?:withdraw|revoke).{0,40}consent\b|सहमति.{0,30}वापस/iu],
  ['data_items_purposes', /\b(?:collect|data items?|personal data|purpose)\b|व्यक्तिगत डेटा/iu],
  ['access_right', /\b(?:right to access|request access|access your (?:personal )?data)\b/iu],
  ['correction_erasure', /\b(?:correct|correction|erase|erasure|delete your data)\b/iu],
  ['grievance_contact', /\b(?:grievance|complaint)\b|शिकायत/iu],
  ['nomination', /\b(?:nominate|nomination)\b/iu],
  ['identity_verification', /\b(?:verify your identity|identity verification)\b/iu],
  ['portability', /\b(?:portability|export your data)\b/iu],
  ['breach_statement', /\b(?:breach|data incident)\b/iu],
  ['transfer_statement', /\b(?:cross.border|transfer.*outside|international transfer)\b/iu],
  ['children_statement', /\b(?:child|children|under 18|minor)\b|बच्चों/iu],
  ['dpo_contact', /\b(?:data protection officer|DPO)\b/iu],
  ['dpia_statement', /\b(?:DPIA|data protection impact assessment)\b/iu],
  ['audit_statement', /\b(?:audit|auditor)\b/iu],
  ['security_statement', /\b(?:security|encryption|safeguards?)\b|सुरक्षा/iu],
  ['retention_statement', /\b(?:retention|retain|deletion period)\b/iu],
  ['privacy_contact', /\b(?:privacy.{0,25}contact|contact.{0,25}privacy)\b/iu],
  ['accountability_statement', /\b(?:accountability|responsible for compliance)\b/iu],
];
type DataCategory = NonNullable<Candidate['staticControl']>['likelyDataCategory'];
const categories: readonly [Exclude<DataCategory, 'other' | 'unknown'>, RegExp][] = [
  ['email', /\b(?:e.?mail)\b|ईमेल/iu],
  ['telephone', /\b(?:tel|phone|telephone|mobile)\b|फ़ोन|फोन/iu],
  ['name', /\b(?:name|given-name|family-name)\b|नाम/iu],
  ['address', /\b(?:address|street|postal|zip)\b|पता/iu],
  ['identifier', /\b(?:username|identifier|customer.?id|account.?id)\b/iu],
  ['free_text', /\b(?:message|comment|feedback)\b|संदेश/iu],
];
function context(n: Element, inherited: Context, budget: Coverage): Context {
  const heading = n.childNodes.find((c) => isElement(c) && /^h[1-6]$/.test(c.tagName));
  const hint = [
    attr(n, 'class'),
    attr(n, 'id'),
    attr(n, 'aria-label'),
    heading ? text(heading, budget, 256) : '',
  ].join(' ');
  if (/\b(?:demo|demonstration|example|sample|mock|preview)\b|डेमो/iu.test(hint)) return 'demo';
  if (inherited === 'demo') return inherited;
  if (n.tagName === 'blockquote' || n.tagName === 'q' || inherited === 'quoted') return 'quoted';
  return inherited;
}

function validatedSource(value: unknown): PublicControlPayloadV2 {
  const result = publicControlPayloadV2Schema.safeParse(value);
  if (!result.success) throw new Error('Public evidence output refused');
  return result.data;
}
export function extractPublicEvidenceV2(input: unknown): PublicControlPayloadV2 {
  const admission = inputSchema.safeParse(input);
  if (!admission.success) throw new Error('Public evidence input refused');
  const parsed = admission.data;
  // Validate coverage before parsing any supplied bytes, including unique page kinds.
  const result = validatedSource({
    ...parsed,
    version: 2,
    extractorVersion: 'static-public-2',
    pages: parsed.pages.map((p) => ({
      page: p.page,
      state: p.state,
      ...(p.state === 'examined' ? { contentSha256: p.contentSha256 } : {}),
      truncated: false,
      coverageReasons: [],
    })),
    candidates: [],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  });
  for (const source of parsed.pages) {
    if (source.state !== 'examined') continue;
    const bytes = Buffer.from(source.html);
    if (createHash('sha256').update(bytes).digest('hex') !== source.contentSha256)
      throw new Error('Public source content hash mismatch');
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = parsePublicHtml(html);
    const coverage = result.pages.find((p) => p.page === source.page)!;
    const elements: { node: Element; ordinal: number; context: Context }[] = [];
    const stack: { node: Node; context: Context }[] = [
      { node: document, context: 'ordinary_public_content' },
    ];
    let visited = 0,
      ordinal = 0;
    while (stack.length) {
      if (++visited > 16384) {
        markCoverage(coverage, 'node_budget');
        break;
      }
      const entry = stack.pop()!;
      const n = entry.node;
      let ctx = entry.context;
      if ('tagName' in n && !isElement(n)) {
        markCoverage(coverage, 'unsupported_foreign_markup');
        continue;
      }
      if (isElement(n)) {
        ordinal++;
        if (excluded(n)) continue;
        ctx = context(n, ctx, coverage);
        elements.push({ node: n, ordinal, context: ctx });
      }
      if ('childNodes' in n)
        for (let i = n.childNodes.length - 1; i >= 0; i--)
          stack.push({ node: n.childNodes[i]!, context: ctx });
    }
    const labels = new Map<string, string>();
    const ids = new Map<string, Element>();
    for (const { node } of elements) {
      const id = attr(node, 'id');
      if (id && id.length <= 128 && !ids.has(id)) ids.set(id, node);
      if (node.tagName === 'label') {
        const target = attr(node, 'for');
        if (target && target.length <= 128 && !labels.has(target))
          labels.set(target, text(node, coverage, 512));
      }
    }
    const add = (
      item: Omit<Candidate, 'ordinal' | 'locator' | 'textDisposition' | 'requiresHumanReview'>,
      elementOrdinal: number,
    ) => {
      if (result.candidates.length === 128) {
        result.candidatesTruncated = true;
        markCoverage(coverage, 'candidate_limit');
        return;
      }
      result.candidates.push({
        ...item,
        ordinal: result.candidates.length + 1,
        locator: { page: source.page, contentSha256: source.contentSha256, elementOrdinal },
        textDisposition: 'redacted_public_text',
        requiresHumanReview: true,
      });
    };
    for (const entry of elements) {
      const n = entry.node;
      if (controls.has(n.tagName)) {
        const rawType = (attr(n, 'type') ?? 'text').toLowerCase();
        const label = [
          attr(n, 'aria-label'),
          n.tagName === 'button'
            ? n.childNodes
                .slice(0, 16)
                .map((child) => text(child, coverage, 128))
                .join(' ')
            : '',
          attr(n, 'autocomplete'),
          attr(n, 'name'),
          labels.get(attr(n, 'id') ?? ''),
          ...(attr(n, 'aria-labelledby') ?? '')
            .split(/\s+/u)
            .slice(0, 10)
            .map((id) => (ids.has(id) ? text(ids.get(id)!, coverage, 256) : '')),
          n.parentNode && isElement(n.parentNode) && n.parentNode.tagName === 'label'
            ? text(n.parentNode, coverage, 512)
            : '',
        ]
          .join(' ')
          .slice(0, 2048)
          .replace(/[_\-\[\].]/gu, ' ');
        if (secret(label) || /\b(?:token|csrf|password|secret|api.?key)\b/iu.test(label)) {
          markCoverage(coverage, 'sensitive_control_suppressed');
          continue;
        }
        const signals = categories
          .filter(([, pattern]) => pattern.test(label))
          .map(([category]) => category);
        if (n.tagName === 'input' && rawType === 'email') signals.push('email');
        if (n.tagName === 'input' && rawType === 'tel') signals.push('telephone');
        const distinct = [...new Set(signals)];
        const likelyDataCategory =
          distinct.length === 1
            ? distinct[0]!
            : distinct.length === 0 && n.tagName === 'textarea'
              ? 'free_text'
              : 'unknown';
        const nearby = n.parentNode ? text(n.parentNode, coverage, 512) : '';
        const consent = /consent|accept|agree|cookies?|analytics|सहमति/iu.test(
          label + ' ' + nearby,
        );
        const isConsent =
          (n.tagName === 'button' || rawType === 'checkbox' || rawType === 'radio') && consent;
        if (n.tagName === 'button' && !isConsent) continue;
        const qualified =
          entry.context === 'ordinary_public_content' && isConsent ? 'ambiguous' : entry.context;
        add(
          {
            facet: isConsent ? 'consent_ui' : 'data_items_purposes',
            kind: 'static_observation',
            context:
              distinct.length > 1 && qualified === 'ordinary_public_content'
                ? 'ambiguous'
                : qualified,
            staticControl: {
              element: n.tagName as 'input' | 'select' | 'textarea' | 'button',
              ...(n.tagName === 'input'
                ? {
                    inputType: ['text', 'email', 'tel', 'checkbox', 'radio'].includes(rawType)
                      ? (rawType as 'text' | 'email' | 'tel' | 'checkbox' | 'radio')
                      : ('other' as const),
                  }
                : {}),
              likelyDataCategory,
              checkedAttribute: attr(n, 'checked') !== undefined,
              requiredAttribute: attr(n, 'required') !== undefined,
              disabledAttribute: attr(n, 'disabled') !== undefined,
            },
            excerpt: isConsent
              ? 'Static consent-related control candidate; operation and consent validity are unverified.'
              : `Static field metadata suggests ${likelyDataCategory}; field values and actual collection are unverified.`,
          },
          entry.ordinal,
        );
        if (isConsent && /parent|guardian|अभिभावक/iu.test(label + ' ' + nearby))
          add(
            {
              facet: 'parental_consent_ui',
              kind: 'static_observation',
              context: qualified,
              excerpt:
                'Static parental-consent-related control candidate; age verification and operation are unverified.',
            },
            entry.ordinal,
          );
      }
      if (!['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'dd'].includes(n.tagName))
        continue;
      const value = text(n, coverage);
      if (!value) continue;
      const hits = facets.filter(([, pattern]) => pattern.test(value));
      if (!hits.length) continue;
      if (value.length > 512) markCoverage(coverage, 'excerpt_limit');
      const excerpt = redact(value);
      if (!excerpt) {
        markCoverage(coverage, 'unsafe_text_suppressed');
        continue;
      }
      for (const [facet] of hits)
        add({ facet, kind: 'public_declaration', context: entry.context, excerpt }, entry.ordinal);
    }
  }
  return validatedSource(result);
}
