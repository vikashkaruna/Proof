import { policyDocumentPayloadSchema, type WorkflowRecord } from '@axiom/types';
import { z } from 'zod';

export const generatedPolicyKindSchema = z.enum([
  'privacy_notice',
  'consent_notice',
  'retention',
  'dpa_template',
]);
function boundedText(value: string, limit: number) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}
export function composePolicyPreview(
  record: WorkflowRecord,
  category: z.infer<typeof generatedPolicyKindSchema>,
) {
  if (record.kind !== 'ropa') throw new Error('processing_source_required');
  const p = record.payload;
  const unknown = 'Unknown — authorised human confirmation required';
  const list = (value: string[] | null) =>
    value === null
      ? unknown
      : value.length
        ? value.join(', ')
        : 'Human recorded none (review required)';
  const flag = (value: boolean | null) =>
    value === null
      ? unknown
      : value
        ? 'Human recorded yes (review required)'
        : 'Human recorded no (review required)';
  const label = {
    privacy_notice: 'Privacy Notice',
    consent_notice: 'Consent Notice',
    retention: 'Retention Policy',
    dpa_template: 'Data Processing Agreement Template',
  }[category];
  const prompts = {
    privacy_notice:
      'Confirm organisation legal name, controller identity, contact details, rights request routes, notice languages and applicable legal obligations before publication.',
    consent_notice:
      'Confirm each specific purpose, item of personal data, applicable lawful basis, clear affirmative action, notice language, consent evidence and withdrawal route. This draft does not prove consent was obtained.',
    retention:
      'Confirm retention triggers, deletion methods, legal holds, exceptions, owner and review schedule. This draft authorises no deletion or client system change.',
    dpa_template:
      'Verify the parties and roles, processing instructions, duration, purpose, subprocessors, confidentiality, security, incident notification, rights assistance, audit terms, transfers, return or deletion and signatures with legal counsel. This unsigned template creates no agreement.',
  }[category];
  return policyDocumentPayloadSchema.parse({
    engagementId: p.engagementId,
    sourceRopaId: record.id,
    sourceNote: boundedText(
      `Draft generated from human-recorded processing activity ${record.id}, audit receipt ${record.receipt_id}. Source: ${p.sourceNote}`,
      2000,
    ),
    ...(p.source ? { source: p.source } : {}),
    title: boundedText(`Draft ${label} — ${p.system}`, 300),
    category,
    content: [
      `DRAFT ${label.toUpperCase()} — UNPUBLISHED`,
      'Human and legal review required. Recorded declarations are not independently verified legal or processing facts.',
      `Processing activity record: ${record.id}`,
      `Human audit receipt: ${record.receipt_id}`,
      `System or activity: ${p.system}`,
      `Recorded purpose: ${p.purpose ?? unknown}`,
      `Recorded legal basis: ${p.legalBasis ?? unknown}`,
      `Recorded data categories: ${list(p.dataCategories)}`,
      `Recorded data principal groups: ${list(p.dataPrincipals)}`,
      `Recorded processors: ${list(p.processors)}`,
      `Recorded recipients: ${list(p.recipients)}`,
      `Recorded retention: ${p.retentionMonths === null ? unknown : `${p.retentionMonths} months (review required)`}`,
      `Recorded processing location: ${p.region ?? unknown}`,
      `Cross-border declaration: ${flag(p.crossBorder)}`,
      `Recorded destinations: ${list(p.destinationCountries)}`,
      `Recorded transfer safeguards: ${p.transferSafeguards ?? unknown}`,
      `Recorded security measures: ${p.securityMeasures ?? unknown}`,
      `Impact assessment declaration: ${flag(p.dpiaRequired)}`,
      `Source and reason: ${p.sourceNote}`,
      ...(p.source
        ? [
            `Retained public observation: ${p.source.observationId}`,
            `Exact observation output SHA-256: ${p.source.outputSha256}`,
          ]
        : []),
      'Public website structure alone does not establish private processing facts, contracts, lawful basis, residency or compliance.',
      prompts,
      'Approval of a draft is separate from publication and does not authorise agent execution.',
    ].join('\n\n'),
  });
}
