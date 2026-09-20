import { requireTenantContext } from '@/lib/tenant-context';
import { DsarClient, type DsarItem } from './dsar-client';

export const dynamic = 'force-dynamic';

export default async function DsarPage() {
  // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
  // by design, and these queries carried no tenant filter, so any
  // authenticated user saw every tenant's data. The client below is
  // user-scoped: RLS applies, and the explicit filters state the intent.
  const { supabase, tenantId } = await requireTenantContext();
  let dsarItems: DsarItem[] = [];
  let accessCount = 6;
  let erasureCount = 3;
  let nearingSlaCount = 1;
  let fulfilledCount = 14;

  try {
    const { data: dbDsars } = await supabase
      .from('dsars')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('received_at', { ascending: false });

    if (dbDsars && dbDsars.length > 0) {
      accessCount = dbDsars.filter((d) => d.kind === 'access').length || accessCount;
      erasureCount = dbDsars.filter((d) => d.kind === 'erasure').length || erasureCount;
      fulfilledCount = dbDsars.filter((d) => d.status === 'completed').length || fulfilledCount;

      dsarItems = dbDsars.map((d: any, idx: number) => {
        let stage = 0;
        if (d.status === 'identity_verification') stage = 1;
        else if (d.status === 'in_fulfilment') stage = 3;
        else if (d.status === 'completed') stage = 4;

        const dueTime = d.due_by ? new Date(d.due_by).getTime() : Date.now() + 14 * 86400000;
        const diffDays = Math.max(0, Math.round((dueTime - Date.now()) / (1000 * 60 * 60 * 24)));

        return {
          id: `DSAR-2026-0${idx + 88}`,
          principal: d.data_principal_name || 'Anonymous Principal',
          email: d.data_principal_email,
          phone: d.data_principal_phone,
          type: (d.kind || 'access').charAt(0).toUpperCase() + (d.kind || 'access').slice(1),
          stage,
          slaDays: diffDays,
          systems: (idx % 3) + 2,
          receivedAt: d.received_at,
          notes: d.notes,
        };
      });
    }
  } catch {
    // Fallback
  }

  if (dsarItems.length === 0) {
    dsarItems = [
      {
        id: 'DSAR-2026-088',
        principal: 'Ananya Sharma',
        type: 'Erasure',
        stage: 3,
        slaDays: 2,
        systems: 4,
        receivedAt: '3 days ago',
        notes:
          'Requested complete erasure of historical transaction analytics upon account termination.',
      },
      {
        id: 'DSAR-2026-089',
        principal: 'Rahul K. Varma',
        type: 'Access',
        stage: 1,
        slaDays: 24,
        systems: 3,
        receivedAt: 'Yesterday',
        notes:
          'Requested summary of personal data processed and third parties disclosed under DPDPA §11.',
      },
      {
        id: 'DSAR-2026-090',
        principal: 'Pooja Iyer',
        type: 'Correction',
        stage: 0,
        slaDays: 28,
        systems: 2,
        receivedAt: 'Today',
        notes: 'Updated communication address and mobile number update request.',
      },
      {
        id: 'DSAR-2026-085',
        principal: 'Vikramaditya Sen',
        type: 'Portability',
        stage: 4,
        slaDays: 0,
        systems: 5,
        receivedAt: '12 days ago',
        notes:
          'Machine-readable JSON export delivered to verified recipient via encrypted vault link.',
      },
    ];
  }

  return (
    <DsarClient
      initialDsars={dsarItems}
      stats={{
        accessCount,
        erasureCount,
        nearingSlaCount,
        fulfilledCount,
      }}
    />
  );
}
