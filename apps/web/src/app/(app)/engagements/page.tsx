import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireTenantContext } from '@/lib/tenant-context';
import {
  PageHeader,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  PostureScore,
} from '@axiom/ui';
import { formatDate, formatINR } from '@axiom/ui';

export const dynamic = 'force-dynamic';

export default async function EngagementsListPage() {
  const { supabase, userId } = await requireTenantContext();
  const user = { id: userId };

  const { data: engagements } = await supabase
    .from('engagements')
    .select(
      'id, title, status, posture_score, estimated_exposure_inr, started_at, completed_at, tenant_id, library_version, tenants:tenant_id(name)',
    )
    .order('started_at', { ascending: false });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Engagements"
        description="An engagement is a (tenant × library-version) assessment run. Each flows through discovery → classification → assessment → planning → approval → execution → verification."
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-mist-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Posture</th>
                <th className="px-4 py-2">Exposure</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {(engagements ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No engagements yet.
                  </td>
                </tr>
              )}
              {(engagements ?? []).map((e) => (
                <tr key={e.id} className="hover:bg-mist-50">
                  <td className="px-4 py-2 font-medium text-slate-700">{e.title}</td>
                  <td className="px-4 py-2 text-slate-600">{e.tenants?.[0]?.name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-4 py-2">
                    <PostureScore score={e.posture_score} variant="compact" />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {e.estimated_exposure_inr ? formatINR(e.estimated_exposure_inr) : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{formatDate(e.started_at)}</td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/engagements/${e.id}`}
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-mist-100"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
