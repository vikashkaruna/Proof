import Link from 'next/link';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { can } from '@axiom/types';
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
import { moduleBarProps } from '@/lib/module-bar';
import { CreateAssessmentForm } from './create-assessment-form';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function EngagementsListPage() {
  const { supabase, tenantId, role, userId } = await requireCapabilityContext(
    routeCapability('/engagements'),
  );
  const canCreate = can(Capability.ENGAGEMENT_CREATE, { role });

  const [engagementResult, libraryResult, estateResult] = await Promise.all([
    supabase
      .from('engagements')
      .select(
        'id, title, status, posture_score, estimated_exposure_inr, started_at, completed_at, tenant_id, library_version, tenants:tenant_id(name)',
      )
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false }),
    canCreate
      ? supabase
          .from('control_libraries')
          .select('version')
          .eq('is_current', true)
          .eq('status', 'published')
          .maybeSingle()
      : Promise.resolve(null),
    canCreate
      ? supabase
          .from('estates')
          .select('id, name')
          .eq('tenant_id', tenantId)
          .eq('status', 'active')
          .order('name')
      : Promise.resolve(null),
  ]);
  const { data: engagements, error } = engagementResult;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        module={moduleBarProps('engagements')}
        title="Engagements"
        description="An engagement is a (tenant × library-version) assessment run. Each flows through discovery → classification → assessment → planning → approval → execution → verification."
      />

      {canCreate &&
        (libraryResult?.error ||
        !libraryResult?.data ||
        estateResult?.error ||
        !estateResult?.data ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            Assessment setup is unavailable because the current published library or estate choices
            could not be verified. Refresh to try again.
          </p>
        ) : (
          <CreateAssessmentForm
            actorId={userId}
            tenantId={tenantId}
            libraryVersion={libraryResult.data.version}
            estates={estateResult.data}
          />
        ))}

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
              {error && (
                <tr>
                  <td colSpan={7} role="alert" className="px-4 py-8 text-center text-red-700">
                    Engagement records are unavailable.
                  </td>
                </tr>
              )}
              {!error && (engagements ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No engagements yet.{' '}
                    {canCreate
                      ? 'Use Create assessment above to start one.'
                      : 'Ask an assessment owner to start one.'}
                  </td>
                </tr>
              )}
              {!error &&
                (engagements ?? []).map((e) => (
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
                      {e.estimated_exposure_inr == null ? '—' : formatINR(e.estimated_exposure_inr)}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDate(e.started_at)}</td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/engagements/${e.id}`}
                        className="rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-mist-100"
                      >
                        Open
                      </Link>
                      <a
                        href={`/assessment?engagement=${e.id}`}
                        className="ml-2 rounded-md border border-teal-300 px-3 py-1 text-xs text-teal-800 hover:bg-teal-50"
                      >
                        View assessment
                      </a>
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
