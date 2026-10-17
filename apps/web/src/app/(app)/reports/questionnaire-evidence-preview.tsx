import { z } from 'zod';
import type { ReportDetail } from './report-contract';

// Display projection of document6 (questionnaire-only requests, 0155). The
// authenticated HTML/PDF endpoints independently enforce source, review and
// artifact custody; this panel grants no authority and shows no estimate.
const count = z.number().int().min(0).max(100000);
const projection = z.object({
  schema_version: z.literal(6),
  kind: z.enum(['board_report', 'auditor_pack']),
  title: z.string(),
  engagement_id: z.uuid(),
  metrics: z.object({
    state: z.literal('withheld'),
    compliance_conclusion: z.literal('not_determined'),
  }),
  questionnaire: z.object({
    provenance: z.enum(['caller_declared_unverified', 'unavailable']),
    libraryVersion: z.string(),
  }),
  summary: z.object({
    controls: count,
    provenanceUnavailable: count,
    unknown: count,
    declaredNotApplicable: count,
    notBooleanAssessable: count,
    declarationsRecorded: count,
  }),
  declarationsVerified: z.literal(false),
  evidenceVerified: z.literal(false),
  humanReviewRequired: z.literal(true),
});

export function QuestionnaireEvidencePreview({ report }: { report: ReportDetail }) {
  if (!report.contentText || report.contentText.length > 4 * 1024 * 1024) return null;
  let parsed: z.infer<typeof projection>;
  try {
    parsed = projection.parse(JSON.parse(report.contentText));
    if (
      parsed.title !== report.title ||
      parsed.engagement_id !== report.engagementId ||
      parsed.questionnaire.libraryVersion !== report.libraryVersion ||
      parsed.kind !==
        (report.kind === 'board'
          ? 'board_report'
          : report.kind === 'auditor'
            ? 'auditor_pack'
            : null)
    )
      return null;
  } catch {
    return null;
  }
  const items = [
    ['Control entries', parsed.summary.controls],
    ['Declarations recorded — unverified', parsed.summary.declarationsRecorded],
    ['Unknown — declarations or applicability open', parsed.summary.unknown],
    ['Declared not applicable — unverified', parsed.summary.declaredNotApplicable],
    ['Controls requiring other evidence', parsed.summary.notBooleanAssessable],
    ['Questionnaire provenance unavailable', parsed.summary.provenanceUnavailable],
  ] as const;
  const identifier = encodeURIComponent(report.id);
  const htmlEndpoint = `/api/bff/v1/reports/statutory/${identifier}/html`;
  const pdfEndpoint = `/api/bff/v1/reports/${report.kind === 'board' ? 'board' : 'statutory'}/${identifier}/pdf`;
  return (
    <section
      aria-label="Questionnaire evidence coverage"
      className="space-y-3 rounded border border-slate-200 p-4"
    >
      <h4 className="font-semibold">Questionnaire evidence coverage</h4>
      <p className="font-medium">
        Scores, score bands and financial exposure estimates are withheld.
      </p>
      <p className="text-sm text-slate-600">
        This report rests on unverified questionnaire declarations only. They do not establish
        implementation, applicability or a compliance conclusion. These are recorded coverage
        counts, not a compliance score.
        {parsed.questionnaire.provenance === 'unavailable' &&
          ' Questionnaire provenance is unavailable for this assessment run.'}
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-slate-600">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {report.status === 'published' ? (
        <a className="underline" href={pdfEndpoint} target="_blank" rel="noopener noreferrer">
          View retained PDF
        </a>
      ) : report.status !== 'archived' ? (
        <a className="underline" href={htmlEndpoint} target="_blank" rel="noopener noreferrer">
          Preview readable report
        </a>
      ) : null}
      <p className="text-xs text-slate-600">
        Read the complete report for each control&apos;s qualified state and the proof still needed.
        Preview access does not approve or release a report.
      </p>
    </section>
  );
}
