'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { formatDateTime } from '@/lib/display-time';

const counts = z.record(z.string(), z.number().int().nonnegative());
const reportSchema = z.object({
  version: z.literal('data-discovery-report/1'),
  organisation: z.string(),
  system: z.string(),
  connectorName: z.string(),
  engine: z.string(),
  targetBinding: z.enum(['production', 'sandbox', 'reference-mock']),
  enumeratedAt: z.string(),
  summary: z.object({
    tables: z.number(),
    tablesWithPersonalData: z.number(),
    sampledTables: z.number(),
    personalColumns: z.number(),
    estimatedPersonalRecords: z.number(),
    categories: counts,
    detectedShapes: counts,
  }),
  tables: z.array(
    z.object({
      resource: z.string(),
      estimatedRows: z.number(),
      categories: z.array(z.string()),
      sampled: z.boolean(),
      sampledAt: z.string().nullable(),
      personalColumns: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          categories: z.array(z.string()),
          detected: counts,
          sampled: z.number(),
          nonNull: z.number(),
        }),
      ),
      otherColumnCount: z.number(),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      detail: z.string(),
      provision: z.string(),
      resources: z.array(z.string()),
    }),
  ),
  limitations: z.array(z.string()),
});
type Report = z.infer<typeof reportSchema>;
const findingSchema = reportSchema.shape.findings.element;
const websiteReportSchema = z.object({
  version: z.literal('authenticated-website-report/1'),
  organisation: z.string(),
  system: z.string(),
  connectorName: z.string(),
  targetBinding: z.enum(['production', 'sandbox', 'reference-mock']),
  baseUrl: z.string(),
  checkedAt: z.string(),
  summary: z.object({
    pagesRead: z.number(),
    pagesSkipped: z.number(),
    personalDataForms: z.number(),
    personalFields: z.number(),
    categories: counts,
  }),
  rights: z.array(z.object({ key: z.string(), label: z.string(), paths: z.array(z.string()) })),
  findings: z.array(findingSchema),
  pages: z.array(
    z.object({
      path: z.string(),
      forms: z.array(
        z.object({
          fields: z.array(z.object({ name: z.string(), categories: z.array(z.string()) })),
          consentControl: z.boolean(),
          purposeText: z.boolean(),
        }),
      ),
    }),
  ),
  limitations: z.array(z.string()),
});
type WebsiteReport = z.infer<typeof websiteReportSchema>;

const SEVERITY_CLASS: Record<Report['findings'][number]['severity'], string> = {
  high: 'border-ember-500 bg-ember-50 text-ember-900',
  medium: 'border-teal-500 bg-teal-50 text-teal-900',
  low: 'border-slate-300 bg-slate-50 text-slate-800',
};
const SHAPE_LABEL: Record<string, string> = {
  email: 'email',
  phone_in: 'Indian mobile',
  pan: 'PAN',
  aadhaar_like: 'Aadhaar-like',
};
const listCounts = (values: Record<string, number>, labels: Record<string, string> = {}) =>
  Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${labels[key] ?? key} ${value}`)
    .join(' · ') || 'none';

export function ScanReportClient({
  tenantId,
  connectorId,
}: {
  tenantId: string;
  connectorId: string;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [website, setWebsite] = useState<WebsiteReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_run' | 'error'>('loading');
  const [downloading, setDownloading] = useState(false);
  const path = `/api/bff/v1/connectors/${connectorId}/scan-report`;
  useEffect(() => {
    const abort = new AbortController();
    fetch(path, { headers: { 'X-Tenant-Id': tenantId }, cache: 'no-store', signal: abort.signal })
      .then(async (response) => {
        if (response.status === 404) {
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: string };
          } | null;
          if (body?.error?.code === 'scan_not_run') return setState('not_run');
          throw new Error();
        }
        if (!response.ok) throw new Error();
        const data = ((await response.json()) as { data: unknown }).data;
        const signedIn = websiteReportSchema.safeParse(data);
        if (signedIn.success) {
          if (!abort.signal.aborted) {
            setWebsite(signedIn.data);
            setState('ready');
          }
          return;
        }
        const parsed = reportSchema.parse(data);
        if (!abort.signal.aborted) {
          setReport(parsed);
          setState('ready');
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setState('error');
      });
    return () => abort.abort();
  }, [path, tenantId]);

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(`${path}?format=html`, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = website ? 'signed-in-website-scan.html' : 'data-discovery-scan.html';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setState('error');
    } finally {
      setDownloading(false);
    }
  }

  if (state === 'loading') return <p role="status">Loading the scan report…</p>;
  if (state === 'not_run')
    return (
      <p className="rounded border p-4 text-sm">
        No completed scan yet. On the Connectors page, open this connector and select{' '}
        <strong>Run full scan</strong>.
      </p>
    );
  if (state === 'ready' && website)
    return (
      <WebsiteReportView
        report={website}
        downloading={downloading}
        onDownload={() => void download()}
      />
    );
  if (state === 'error' || !report)
    return (
      <p role="alert" className="rounded border p-4 text-sm">
        The scan report could not be loaded. Refresh to try again.
      </p>
    );
  const personalTables = report.tables.filter((table) => table.personalColumns.length > 0);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Scan summary" className="rounded-lg border bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-indigo-900">
              {report.organisation} — {report.system}
            </h2>
            <p className="text-sm text-slate-600">
              {report.engine} connector “{report.connectorName}” · catalogue read{' '}
              {formatDateTime(report.enumeratedAt)}
              {report.targetBinding === 'sandbox' ? ' · synthetic demo database' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void download()}
            disabled={downloading}
            className="rounded-md border border-teal-700 px-3 py-2 text-sm font-medium text-teal-800 disabled:opacity-50"
          >
            {downloading ? 'Preparing…' : 'Download report (HTML)'}
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(
            [
              ['Relations scanned', report.summary.tables],
              ['Hold personal data', report.summary.tablesWithPersonalData],
              ['Personal-data columns', report.summary.personalColumns],
              ['Relations sampled', report.summary.sampledTables],
              [
                'High-priority prompts',
                report.findings.filter((f) => f.severity === 'high').length,
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded border p-3">
              <dt className="text-xs text-slate-600">{label}</dt>
              <dd className="text-2xl font-semibold text-indigo-900">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-slate-600">
          Categories: {listCounts(report.summary.categories)}
        </p>
        <p className="text-sm text-slate-600">
          Detected value shapes: {listCounts(report.summary.detectedShapes, SHAPE_LABEL)}
        </p>
      </section>
      <section aria-label="Review prompts" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-indigo-900">Review prompts</h2>
        {report.findings.length === 0 && <p className="text-sm">No prompts were raised.</p>}
        {report.findings.map((finding) => (
          <article
            key={finding.id}
            className={`rounded-md border-l-4 p-4 text-sm ${SEVERITY_CLASS[finding.severity]}`}
          >
            <h3 className="font-semibold">
              <span className="mr-2 text-xs uppercase tracking-wide">{finding.severity}</span>
              {finding.title}
            </h3>
            <p className="mt-1">{finding.detail}</p>
            <p className="mt-1 text-xs">Check: {finding.provision}</p>
            <p className="text-xs">Relations: {finding.resources.join(', ')}</p>
          </article>
        ))}
      </section>
      <section aria-label="Personal data inventory" className="overflow-x-auto">
        <h2 className="mb-2 text-lg font-semibold text-indigo-900">Personal data inventory</h2>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-slate-100">
              <th className="border p-2">Relation</th>
              <th className="border p-2">Column</th>
              <th className="border p-2">Categories</th>
              <th className="border p-2">Detected in sample</th>
            </tr>
          </thead>
          <tbody>
            {personalTables.length === 0 && (
              <tr>
                <td colSpan={4} className="border p-2">
                  No personal-data columns were identified.
                </td>
              </tr>
            )}
            {personalTables.flatMap((table) =>
              table.personalColumns.map((column, index) => (
                <tr key={`${table.resource}.${column.name}`}>
                  {index === 0 && (
                    <td rowSpan={table.personalColumns.length} className="border p-2 align-top">
                      {table.resource}
                      <span className="block text-xs text-slate-500">
                        ~{table.estimatedRows} rows{table.sampled ? '' : ' · not sampled'}
                      </span>
                    </td>
                  )}
                  <td className="border p-2">{column.name}</td>
                  <td className="border p-2">{column.categories.join(', ')}</td>
                  <td className="border p-2">
                    {column.sampled > 0
                      ? `${listCounts(column.detected, SHAPE_LABEL)} (of ${column.nonNull}/${column.sampled})`
                      : 'not sampled'}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
      <section aria-label="Limitations" className="text-sm text-slate-600">
        <h2 className="mb-1 text-lg font-semibold text-indigo-900">Limitations</h2>
        <ul className="list-inside list-disc">
          {report.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Findings({ findings }: { findings: Report['findings'] }) {
  return (
    <section aria-label="Review prompts" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-indigo-900">Review prompts</h2>
      {findings.length === 0 && <p className="text-sm">No prompts were raised.</p>}
      {findings.map((finding) => (
        <article
          key={finding.id}
          className={`rounded-md border-l-4 p-4 text-sm ${SEVERITY_CLASS[finding.severity]}`}
        >
          <h3 className="font-semibold">
            <span className="mr-2 text-xs uppercase tracking-wide">{finding.severity}</span>
            {finding.title}
          </h3>
          <p className="mt-1">{finding.detail}</p>
          <p className="mt-1 text-xs">Check: {finding.provision}</p>
          <p className="text-xs">Where: {finding.resources.join(', ')}</p>
        </article>
      ))}
    </section>
  );
}

function WebsiteReportView({
  report,
  downloading,
  onDownload,
}: {
  report: WebsiteReport;
  downloading: boolean;
  onDownload: () => void;
}) {
  const forms = report.pages.flatMap((page) =>
    page.forms
      .filter((form) => form.fields.some((field) => field.categories.length > 0))
      .map((form, index) => ({ page: page.path, form, key: `${page.path}:${index}` })),
  );
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Scan summary" className="rounded-lg border bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-indigo-900">
              {report.organisation} — {report.system}
            </h2>
            <p className="text-sm text-slate-600">
              Signed-in website “{report.connectorName}” · {report.baseUrl} · read{' '}
              {formatDateTime(report.checkedAt)}
              {report.targetBinding === 'sandbox' ? ' · synthetic demo portal' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            className="rounded-md border border-teal-700 px-3 py-2 text-sm font-medium text-teal-800 disabled:opacity-50"
          >
            {downloading ? 'Preparing…' : 'Download report (HTML)'}
          </button>
        </div>
        <p className="mt-3 text-sm">
          {report.summary.pagesRead} pages read · {report.summary.pagesSkipped} not opened or
          unavailable · {report.summary.personalDataForms} forms collecting personal data
        </p>
      </section>
      <Findings findings={report.findings} />
      <section aria-label="Data principal rights paths">
        <h2 className="mb-2 text-lg font-semibold text-indigo-900">Data principal rights paths</h2>
        <table className="w-full border-collapse text-left text-sm">
          <tbody>
            {report.rights.map((right) => (
              <tr key={right.key}>
                <th className="w-1/3 border bg-slate-50 p-2 font-medium">{right.label}</th>
                <td className="border p-2">
                  {right.paths.length ? (
                    right.paths.join(', ')
                  ) : (
                    <strong className="text-ember-700">Not found</strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label="Forms collecting personal data" className="overflow-x-auto">
        <h2 className="mb-2 text-lg font-semibold text-indigo-900">
          Forms collecting personal data
        </h2>
        {forms.length === 0 ? (
          <p className="text-sm">None found.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="bg-slate-100">
                <th className="border p-2">Page</th>
                <th className="border p-2">Personal-data fields</th>
                <th className="border p-2">Purpose or consent</th>
              </tr>
            </thead>
            <tbody>
              {forms.map(({ page, form, key }) => (
                <tr key={key}>
                  <td className="border p-2">{page}</td>
                  <td className="border p-2">
                    {form.fields
                      .filter((field) => field.categories.length > 0)
                      .map((field) => `${field.name} (${field.categories.join(', ')})`)
                      .join(', ')}
                  </td>
                  <td className="border p-2">
                    {form.consentControl
                      ? 'Consent control'
                      : form.purposeText
                        ? 'Purpose text'
                        : 'None'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Limitations" className="text-sm text-slate-600">
        <h2 className="mb-1 text-lg font-semibold text-indigo-900">Limitations</h2>
        <ul className="list-inside list-disc">
          {report.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
