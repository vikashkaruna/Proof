import { z } from 'zod';
import { reportPreviewVersion } from './report-preview-version';
import type { ReportDetail } from './report-contract';

// A display projection only. The authenticated HTML/PDF endpoints independently
// enforce source, review and artifact custody; this panel grants no authority.
const count = z.number().int().min(0).max(100000);
const projection = z.object({
  schema_version: z.literal(5),
  kind: z.enum(['board_report', 'auditor_pack']),
  title: z.string(),
  engagement_id: z.uuid(),
  metrics: z.object({
    state: z.literal('withheld'),
    compliance_conclusion: z.literal('not_determined'),
  }),
  coverage: z.object({
    wholeWebsiteExamined: z.literal(false),
    internalEvidenceVerified: z.literal(false),
    candidatesTruncated: z.boolean(),
    pages: z.array(z.object({ page: z.string().max(100), state: z.string().max(100) })).max(5),
  }),
  summary: z.object({
    controls: count,
    questions: count,
    omittedUnknown: count,
    explicitUnknown: count,
    humanYesUnverified: count,
    humanNoUnverified: count,
    notBooleanAssessable: count,
  }),
  provenance: z.object({ libraryVersion: z.string() }),
  declarationsVerified: z.literal(false),
  evidenceVerified: z.literal(false),
  humanReviewRequired: z.literal(true),
});

export function CoverageFirstPreview({ report }: { report: ReportDetail }) {
  if (!report.contentText || report.contentText.length > 4 * 1024 * 1024) return null;
  let parsed: z.infer<typeof projection>;
  try {
    parsed = projection.parse(
      reportPreviewVersion(
        JSON.parse(report.contentText),
        5,
        report.assurance === 'digest_bound' && !!report.contentHash,
      ),
    );
    if (
      parsed.title !== report.title ||
      parsed.engagement_id !== report.engagementId ||
      parsed.provenance.libraryVersion !== report.libraryVersion ||
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
    ['Recorded questions', parsed.summary.questions],
    ['Unknown — no judgment recorded', parsed.summary.omittedUnknown],
    ['Unknown — explicitly recorded', parsed.summary.explicitUnknown],
    ['Human Yes — unverified', parsed.summary.humanYesUnverified],
    ['Human No — unverified', parsed.summary.humanNoUnverified],
    ['Questions requiring other evidence', parsed.summary.notBooleanAssessable],
  ] as const;
  const identifier = encodeURIComponent(report.id);
  const htmlEndpoint = `/api/bff/v1/reports/statutory/${identifier}/html`;
  const pdfEndpoint = `/api/bff/v1/reports/${report.kind === 'board' ? 'board' : 'statutory'}/${identifier}/pdf`;
  return (
    <section
      aria-label="Website evidence coverage"
      className="space-y-3 rounded border border-slate-200 p-4"
    >
      <h4 className="font-semibold">Website evidence coverage</h4>
      <p className="font-medium">Scores and financial exposure estimates are withheld.</p>
      <p className="text-sm text-slate-600">
        Public website evidence and unverified human declarations do not establish internal
        implementation or a compliance conclusion. These are recorded coverage counts, not a
        compliance score. The whole website has not been examined.
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-slate-600">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <ul aria-label="Recorded page coverage" className="space-y-1 text-sm">
        {parsed.coverage.pages.map((page, index) => (
          <li key={`${page.page}/${index}`}>
            {page.page}: {page.state}
          </li>
        ))}
      </ul>
      {parsed.coverage.candidatesTruncated && (
        <p className="text-sm">The saved evidence candidate list is truncated.</p>
      )}
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
        Read the complete report for qualified control findings, evidence references and remaining
        proof requirements. Preview access does not approve or release a report.
      </p>
    </section>
  );
}
