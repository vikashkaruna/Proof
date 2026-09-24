import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireTenantContext } from '@/lib/tenant-context';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  StatusBadge,
  PostureScore,
  SeverityChip,
  Badge,
  AgentPill,
} from '@axiom/ui';
import { formatDate, formatINR } from '@axiom/ui';

export const dynamic = 'force-dynamic';

export default async function EngagementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, userId } = await requireTenantContext();
  const user = { id: userId };

  const { data: engagement } = await supabase
    .from('engagements')
    .select('*, tenants:tenant_id(name, slug)')
    .eq('id', id)
    .single();

  if (!engagement) notFound();

  const { data: findings } = await supabase
    .from('findings')
    .select('id, control_id, status, score, risk_points, rationale, library_version')
    .eq('engagement_id', id)
    .order('risk_points', { ascending: false });

  const { data: plans } = await supabase
    .from('remediation_plans')
    .select('id, title, status, version, created_at')
    .eq('engagement_id', id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={engagement.title}
        description={`Engagement for ${engagement.tenants?.name ?? 'tenant'} using library v${engagement.library_version}.`}
        actions={
          <Link
            href="/engagements"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-mist-100"
          >
            Back
          </Link>
        }
        meta={
          <>
            <StatusBadge status={engagement.status} />
            <Badge variant="indigo">Started {formatDate(engagement.started_at)}</Badge>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Posture</CardTitle>
          </CardHeader>
          <CardContent>
            <PostureScore
              score={engagement.posture_score}
              exposureInr={engagement.estimated_exposure_inr}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Remediation plans</CardTitle>
          </CardHeader>
          <CardContent>
            {(plans ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">
                No plans generated yet. Once Parikshan completes assessment, Sudhaar will generate a
                structured plan with typed actions, dry-runs, and rollback definitions.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(plans ?? []).map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/plans/${p.id}`}
                      className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 hover:bg-mist-100"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-slate-700">{p.title}</span>
                        <span className="text-xs text-slate-500">v{p.version}</span>
                      </div>
                      <StatusBadge status={p.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Findings ({findings?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-mist-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2">Control</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Risk pts</th>
                <th className="px-4 py-2">Rationale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {(findings ?? []).map((f) => (
                <tr key={f.id} className="hover:bg-mist-50">
                  <td className="px-4 py-2">
                    <code className="font-mono text-xs text-indigo-700">{f.control_id}</code>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={f.status} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{Number(f.score).toFixed(0)}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {Number(f.risk_points).toFixed(1)}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    <span className="line-clamp-2">{f.rationale}</span>
                  </td>
                </tr>
              ))}
              {(findings ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No findings yet. Parikshan scores each control when assessment runs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
