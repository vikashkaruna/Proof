import { requireTenantContext } from '@/lib/tenant-context';
import { AssessmentClient, type ControlScore } from './assessment-client';
import { controls as controlLib, CONTROL_LIBRARY_COUNT } from '@axiom/control-library';

export const dynamic = 'force-dynamic';

export default async function AssessmentPage() {
  // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
  // by design, and these queries carried no tenant filter, so any
  // authenticated user saw every tenant's data. The client below is
  // user-scoped: RLS applies, and the explicit filters state the intent.
  const { supabase, tenantId } = await requireTenantContext();
  let controlsData: ControlScore[] = [];
  let isSdf = false;
  let exposureText = '₹18–46 cr';
  // QUA-3: was the literal 43, against a library of 46. Derived now.
  let totalControlsCount = CONTROL_LIBRARY_COUNT;

  try {
    const [engRes, findingsRes, dbControlsRes, tenantRes, evidenceRes] = await Promise.all([
      supabase
        .from('engagements')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('findings')
        .select('control_id, score, status, risk_points')
        .eq('tenant_id', tenantId),
      supabase.from('controls').select('id, title, domain, citations, scoring'),
      supabase.from('tenants').select('is_sdf').limit(1),
      supabase
        .from('evidence')
        .select('id, demonstrates_control_ids, filename')
        .eq('tenant_id', tenantId),
    ]);

    if (tenantRes.data?.[0]?.is_sdf) {
      isSdf = true;
    }

    if (engRes.data?.[0]?.estimated_exposure_inr) {
      const expCr = (engRes.data[0].estimated_exposure_inr / 10000000).toFixed(0);
      exposureText = `₹${expCr} cr`;
    }

    const allControls =
      dbControlsRes.data && dbControlsRes.data.length > 0 ? dbControlsRes.data : controlLib;
    totalControlsCount = allControls.length;

    const findingsMap = new Map((findingsRes.data || []).map((f) => [f.control_id, f]));

    // Map evidence by control
    const evMap = new Map<string, string>();
    (evidenceRes.data || []).forEach((ev) => {
      (ev.demonstrates_control_ids || []).forEach((cid: string) => {
        if (!evMap.has(cid)) {
          evMap.set(cid, `e-${ev.id.slice(0, 4)}`);
        }
      });
    });

    controlsData = allControls.slice(0, 16).map((c: any) => {
      const finding = findingsMap.get(c.id);
      const score = finding ? Number(finding.score) : 85;
      const status: 'pass' | 'partial' | 'fail' =
        score >= 80 ? 'pass' : score >= 40 ? 'partial' : 'fail';

      const citeStr = Array.isArray(c.citations)
        ? c.citations[0]
          ? `${c.citations[0].instrument || '§'} ${c.citations[0].reference || ''}`
          : '§5'
        : typeof c.citations === 'string'
          ? c.citations
          : '§5 · Rule 3';

      const ev =
        evMap.get(c.id) || (score >= 80 ? `e-${c.id.replace(/[^0-9]/g, '') || '8839'}` : '—');

      return {
        id: c.id,
        name: c.title,
        domain: c.domain,
        cite: citeStr,
        ev,
        status,
        score,
      };
    });
  } catch {
    // Fallback handled below
  }

  if (controlsData.length === 0) {
    controlsData = [
      {
        id: 'NOT-01',
        name: 'Itemised notice at collection in 22 scheduled languages',
        domain: 'Notice & consent',
        cite: '§5 · Rule 3',
        ev: 'e-8839',
        status: 'pass',
        score: 100,
      },
      {
        id: 'NOT-04',
        name: 'Withdrawal as easy as giving consent',
        domain: 'Notice & consent',
        cite: '§6(4)',
        ev: 'e-8802',
        status: 'pass',
        score: 100,
      },
      {
        id: 'RTS-01',
        name: 'Right to access information',
        domain: 'Rights of principals',
        cite: '§11',
        ev: 'e-8781',
        status: 'pass',
        score: 100,
      },
      {
        id: 'RTS-04',
        name: 'Right to erasure on withdrawal',
        domain: 'Rights of principals',
        cite: '§12',
        ev: '—',
        status: 'fail',
        score: 20,
      },
      {
        id: 'RTS-06',
        name: 'Grievance redressal mechanism',
        domain: 'Rights of principals',
        cite: '§13',
        ev: '—',
        status: 'partial',
        score: 60,
      },
      {
        id: 'RET-03',
        name: 'Erasure after retention period',
        domain: 'Retention & erasure',
        cite: '§8(7) · Rule 8',
        ev: 'e-8841',
        status: 'fail',
        score: 15,
      },
      {
        id: 'RET-05',
        name: 'Storage limitation on logs',
        domain: 'Retention & erasure',
        cite: '§8(7)',
        ev: '—',
        status: 'fail',
        score: 30,
      },
      {
        id: 'PUR-02',
        name: 'Purpose limitation in analytics',
        domain: 'Purpose limitation',
        cite: '§6',
        ev: 'e-8788',
        status: 'partial',
        score: 55,
      },
      {
        id: 'SEC-06',
        name: 'Least-privilege access to PII',
        domain: 'Security safeguards',
        cite: '§8(4)',
        ev: 'e-8843',
        status: 'partial',
        score: 70,
      },
      {
        id: 'SEC-09',
        name: 'Encryption at rest & in transit',
        domain: 'Security safeguards',
        cite: '§8(5)',
        ev: 'e-8790',
        status: 'pass',
        score: 100,
      },
      {
        id: 'XBR-01',
        name: 'Cross-border transfer register',
        domain: 'Cross-border transfer',
        cite: '§16',
        ev: '—',
        status: 'partial',
        score: 50,
      },
      {
        id: 'BRC-02',
        name: '72-hour breach notification readiness',
        domain: 'Breach',
        cite: 'Rule 7',
        ev: 'e-8790',
        status: 'pass',
        score: 100,
      },
    ];
  }

  const passCount = controlsData.filter((c) => c.status === 'pass').length;
  const partialCount = controlsData.filter((c) => c.status === 'partial').length;
  const failCount = controlsData.filter((c) => c.status === 'fail').length;

  return (
    <AssessmentClient
      initialControls={controlsData}
      initialPassCount={passCount}
      initialPartialCount={partialCount}
      initialFailCount={failCount}
      isSdf={isSdf}
      exposureText={exposureText}
      totalControlsCount={totalControlsCount}
    />
  );
}
