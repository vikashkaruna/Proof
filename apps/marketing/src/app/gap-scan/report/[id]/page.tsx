import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { getGapScanReport, SAMPLE_GAP_SCAN_RECORD } from '@/lib/gap-scan-store';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  PostureScore,
  SeverityChip,
  Button,
} from '@axiom/ui';
import { GapScanReportSchema } from '@axiom/types';
import { BRAND } from '@axiom/config';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import { EmailReportAction } from '../email-report-action';

export async function generateStaticParams() {
  return [{ id: 'preview' }];
}

export default async function GapScanReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let scan;
  if (id === 'preview') {
    scan = SAMPLE_GAP_SCAN_RECORD;
  } else {
    const access = (await cookies()).get('gap_scan_access')?.value;
    const isLocal =
      process.env.ENVIRONMENT === 'local' ||
      process.env.ENVIRONMENT === 'development' ||
      process.env.ENVIRONMENT === 'preprod' ||
      process.env.ENVIRONMENT === 'staging' ||
      process.env.NODE_ENV !== 'production';

    scan = await getGapScanReport(id, access, isLocal);
  }

  if (!scan) {
    console.error(`Gap scan report fetch failed for id: ${id}`);
    notFound();
  }

  const reportResult = GapScanReportSchema.safeParse(scan.report_snapshot);
  if (!reportResult.success) {
    console.error('Gap scan report parse failed:', reportResult.error);
    notFound();
  }
  const report = reportResult.data;
  const readinessIndex = report.readinessIndex;

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-6">
      <Link href="/" className="text-sm text-slate-500 hover:text-indigo-500">
        ← Back to home
      </Link>

      <div>
        <Badge variant="indigo">Statutory Gap-Scan Assessment</Badge>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-indigo-500 sm:text-4xl">
          Your DPDPA Readiness Report
        </h1>
        <p className="mt-2 text-slate-600">
          Scored against {CONTROL_LIBRARY_COUNT} controls from {BRAND.name} Control Library v
          {scan.library_version}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overall posture</CardTitle>
          <CardDescription>
            0–100, where 100 is fully compliant. 5% global discount applied for unverified
            self-attestation — verified controls score higher.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PostureScore score={scan.posture_score} exposureInr={scan.estimated_exposure_inr} />
        </CardContent>
      </Card>

      {/* Interactive Email Dispatch Card */}
      <EmailReportAction
        reportId={scan.id}
        defaultEmail={scan.contact_email}
        defaultName={scan.contact_name}
        defaultPhone={scan.contact_phone}
        defaultCompany={scan.contact_company}
        hasReadinessIndex={Boolean(readinessIndex)}
      />

      {/* Quarterly DPDPA Readiness Index Card (if requested) */}
      {readinessIndex && (
        <Card className="border-teal-300 bg-white shadow-sm">
          <CardHeader className="border-b border-slate-100 bg-mist-50/50 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Badge variant="info">Quarterly Research Benchmark</Badge>
                <CardTitle className="mt-2 text-xl text-indigo-500">
                  The Axiom Proof DPDPA Readiness Index — {readinessIndex.sector}
                </CardTitle>
                <CardDescription>
                  Sector peer standing and quarterly statutory compliance progression milestones.
                </CardDescription>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-2 text-right">
                <span className="text-xs uppercase font-medium text-teal-700">Peer Standing</span>
                <p className="text-lg font-bold text-teal-900">
                  Top {100 - readinessIndex.percentileRank}%
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            <div className="grid grid-cols-2 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-slate-500">Your Score</p>
                <p className="text-xl font-bold text-teal-600">{readinessIndex.companyScore}/100</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Sector Benchmark</p>
                <p className="text-xl font-bold text-slate-700">
                  {readinessIndex.sectorBenchmarkScore}/100
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Status</p>
                <span className="mt-1 inline-block rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-semibold uppercase text-teal-800">
                  {readinessIndex.status.replace('_', ' ')}
                </span>
              </div>
              <div>
                <p className="text-xs text-slate-500">Statutory Risk Weight</p>
                <p className="text-xl font-bold text-indigo-900">
                  {readinessIndex.exposureMultiplier}x Exposure
                </p>
              </div>
            </div>

            <div className="mt-6">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
                Top Statutory Risk Factors in {readinessIndex.sector}
              </h4>
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                {readinessIndex.sectorTopRisks.map((risk, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-ember-500 font-bold">•</span>
                    <span>{risk}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-6">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
                Quarterly Readiness Roadmap
              </h4>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-mist-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Quarter</th>
                      <th className="px-3 py-2">Target Score</th>
                      <th className="px-3 py-2">Core Milestone</th>
                      <th className="px-3 py-2">Statutory Gate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {readinessIndex.quarterlyRoadmap.map((q) => (
                      <tr key={q.quarter} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-medium text-indigo-700">{q.quarter}</td>
                        <td className="px-3 py-2.5 font-mono text-teal-600 font-semibold">
                          {q.targetScore}/100
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">{q.milestone}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">
                          {q.statutoryDeadline}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {report.recommendations?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top 5 things to fix first</CardTitle>
            <CardDescription>Ranked by risk-weighted exposure.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-3">
              {report.recommendations.map((r) => (
                <li
                  key={r.priority}
                  className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-500 font-mono text-sm font-semibold text-white">
                    {r.priority}
                  </span>
                  <div>
                    <p className="font-medium text-slate-700">{r.title}</p>
                    <p className="text-xs text-slate-500">Estimated effort: {r.effort}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All findings ({report.findings?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-mist-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2">Control</th>
                <th className="px-4 py-2">Severity</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Risk pts</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {report.findings.map((f) => (
                <tr key={f.controlId}>
                  <td className="px-4 py-2">
                    <code className="rounded bg-mist-100 px-1 font-mono text-xs text-indigo-700">
                      {f.controlId}
                    </code>
                    <p className="mt-0.5 text-xs text-slate-600">{f.title}</p>
                  </td>
                  <td className="px-4 py-2">
                    <SeverityChip severity={f.severity} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{Number(f.score).toFixed(0)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{Number(f.riskPoints).toFixed(1)}</td>
                  <td className="px-4 py-2 text-xs">
                    {f.score >= 80 ? (
                      <Badge variant="success">Compliant</Badge>
                    ) : f.score >= 40 ? (
                      <Badge variant="warning">Partial</Badge>
                    ) : (
                      <Badge variant="danger">Gap</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {scan.follow_up_requested && (
        <Card>
          <CardContent className="p-6 text-center">
            <h3 className="font-heading text-xl font-semibold text-indigo-500">What's next?</h3>
            <p className="mt-2 text-slate-600">
              The founder will reach out within 1 business day to walk through your findings. This
              is a 30-min call, not a sales pitch.
            </p>
            <Button asChild={false} variant="accent" size="lg" className="mt-4">
              <Link href="/contact">Or book directly</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-slate-500">
        Report ID: {scan.id} · Library v{scan.library_version} · Scored{' '}
        {new Date(scan.created_at).toLocaleString('en-IN')}
        <br />
        {BRAND.copyright}
      </p>
    </div>
  );
}
