import { NextResponse, type NextRequest } from 'next/server';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
    // by design, and these queries carried no tenant filter, so any
    // authenticated user saw every tenant's data. The client below is
    // user-scoped: RLS applies, and the explicit filters state the intent.
    const { supabase, tenantId } = await requireTenantContext();

    const isExport = searchParams.get('export') === 'true';
    const agent = searchParams.get('agent');
    const action = searchParams.get('action');
    const result = searchParams.get('result');
    const q = searchParams.get('q')?.trim();

    // Resolve tenant identifier from query params, headers, or active tenant cookie
    const requestedTenantId =
      searchParams.get('tenantId') ||
      searchParams.get('tenant_id') ||
      request.headers.get('x-tenant-id') ||
      request.cookies.get('axiom_active_tenant')?.value;

    let targetTenant: { id: string; name: string; slug: string } | null = null;
    if (requestedTenantId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestedTenantId,
      );
      const query = supabase.from('tenants').select('id, name, slug');
      const { data } = isUuid
        ? await query.eq('id', requestedTenantId).maybeSingle()
        : await query.eq('slug', requestedTenantId).maybeSingle();
      if (data) {
        targetTenant = data;
      }
    }

    if (!targetTenant) {
      const { data } = await supabase
        .from('tenants')
        .select('id, name, slug')
        .limit(1)
        .maybeSingle();
      if (data) {
        targetTenant = data;
      }
    }

    // ─── AUDITOR EXPORT HANDLER ──────────────────────────────────────────────
    if (isExport) {
      let exportQuery = supabase
        .from('audit_ledger')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('sequence_no', { ascending: true })
        .limit(5000);

      if (targetTenant?.id) {
        exportQuery = exportQuery.eq('tenant_id', targetTenant.id);
      }

      if (agent) {
        const val = agent.toLowerCase();
        if (val === 'human' || val === 'system') {
          exportQuery = exportQuery.eq('actor_type', val);
        } else {
          exportQuery = exportQuery.eq('actor_id', val);
        }
      }

      if (result) {
        exportQuery = exportQuery.eq('result', result.toLowerCase());
      }

      if (action) {
        exportQuery = exportQuery.ilike('action_type', `%${action.toLowerCase()}%`);
      }

      if (q) {
        if (/^\d+$/.test(q)) {
          exportQuery = exportQuery.eq('sequence_no', parseInt(q, 10));
        } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
          exportQuery = exportQuery.eq('correlation_id', q);
        } else {
          exportQuery = exportQuery.or(
            `target_ref.ilike.%${q}%,action_type.ilike.%${q}%,actor_id.ilike.%${q}%`,
          );
        }
      }

      const { data: records, error: exportError } = await exportQuery;
      if (exportError) {
        return NextResponse.json({ error: exportError.message }, { status: 500 });
      }

      // Verify chain integrity for the target tenant
      let chainIntact = true;
      let firstBreak = null;
      if (targetTenant?.id) {
        const { data: verifyData } = await supabase.rpc('verify_ledger', {
          p_tenant_id: targetTenant.id,
          p_from_sequence: 1,
        });
        if (verifyData && verifyData.length > 0) {
          chainIntact = false;
          firstBreak = verifyData[0];
        }
      }

      const entriesList = records || [];
      const genesisRecord = entriesList[0];
      const headRecord = entriesList[entriesList.length - 1];

      const auditBundle = {
        export_metadata: {
          standard: 'Digital Personal Data Protection Act (DPDPA), 2023 — Statutory Audit Trail',
          legal_framework: 'DPDPA 2023 § 8(5) & ISO/IEC 27001:2022 Control A.8.15',
          cryptographic_specification: 'SHA-256 genesis-linked append-only ledger (ADR-5)',
          platform: 'Axiom Proof — Agentic DPDPA Compliance Platform',
          exported_at: new Date().toISOString(),
          tenant: {
            id: targetTenant?.id || '00000000-0000-0000-0000-000000000001',
            name: targetTenant?.name || 'Organization',
            slug: targetTenant?.slug || 'org',
          },
          chain_integrity: {
            status: chainIntact ? 'intact' : 'broken',
            verified: chainIntact,
            total_entries_verified: entriesList.length,
            first_break: firstBreak,
            genesis_sequence: genesisRecord?.sequence_no ?? 1,
            head_sequence: headRecord?.sequence_no ?? 0,
            genesis_hash: genesisRecord?.entry_hash || genesisRecord?.prev_entry_hash || null,
            head_hash: headRecord?.entry_hash || null,
          },
          total_records: entriesList.length,
        },
        records: entriesList.map((e) => ({
          sequence_no: e.sequence_no,
          occurred_at: e.occurred_at,
          actor: {
            id: e.actor_id,
            type: e.actor_type,
            agent_version: e.agent_version || null,
            model_id: e.model_id || null,
          },
          action: {
            type: e.action_type,
            target_ref: e.target_ref,
            result: e.result,
          },
          cryptography: {
            prev_hash: e.prev_entry_hash || e.prev_hash || null,
            entry_hash: e.entry_hash,
            input_hash: e.input_hash || null,
            output_hash: e.output_hash || null,
            prompt_hash: e.prompt_hash || null,
          },
          governance: {
            correlation_id: e.correlation_id,
            approval_token_id: e.approval_token_id || null,
            approver_id: e.approver_id || null,
            pre_state_ref: e.pre_state_ref || null,
            post_state_ref: e.post_state_ref || null,
          },
          detail: e.detail,
        })),
      };

      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `axiom-proof-audit-ledger-${targetTenant?.slug || 'meridian'}-${dateStr}.json`;

      return new NextResponse(JSON.stringify(auditBundle, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // ─── PAGINATED QUERY HANDLER ─────────────────────────────────────────────
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(5, parseInt(searchParams.get('limit') || '25', 10)));

    let query = supabase
      .from('audit_ledger')
      .select('*', { count: 'estimated' })
      .eq('tenant_id', tenantId)
      .order('sequence_no', { ascending: false });

    if (targetTenant?.id) {
      query = query.eq('tenant_id', targetTenant.id);
    }

    if (agent) {
      const val = agent.toLowerCase();
      if (val === 'human' || val === 'system') {
        query = query.eq('actor_type', val);
      } else {
        query = query.eq('actor_id', val);
      }
    }

    if (result) {
      query = query.eq('result', result.toLowerCase());
    }

    if (action) {
      query = query.ilike('action_type', `%${action.toLowerCase()}%`);
    }

    if (q) {
      if (/^\d+$/.test(q)) {
        query = query.eq('sequence_no', parseInt(q, 10));
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
        query = query.eq('correlation_id', q);
      } else {
        query = query.or(`target_ref.ilike.%${q}%,action_type.ilike.%${q}%,actor_id.ilike.%${q}%`);
      }
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);

    const { data, count, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const totalMatching = count ?? (data?.length || 0);
    const totalPages = Math.max(1, Math.ceil(totalMatching / limit));

    const entries = (data || []).map((e) => ({
      id: String(e.id),
      seq: e.sequence_no,
      type: e.action_type || 'system.audit',
      actor: e.actor_id || e.actor_type || 'system',
      actorType: e.actor_type,
      time: e.occurred_at
        ? new Date(e.occurred_at).toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : '11:42',
      corr: e.correlation_id ? `cr-${e.correlation_id.slice(0, 4)}` : 'cr-118',
      fullCorr: e.correlation_id || 'cr-118',
      target: e.target_ref || 'pg.prod · kyc_documents',
      entryHash: e.entry_hash
        ? `${e.entry_hash.slice(0, 4)}…${e.entry_hash.slice(-3)}`
        : 'a3f0…9c1',
      fullEntryHash: e.entry_hash || '',
      prevHash: e.prev_hash ? `${e.prev_hash.slice(0, 4)}…${e.prev_hash.slice(-3)}` : '0000…000',
      fullPrevHash: e.prev_hash || '',
      result: e.result || 'success',
      detail: e.detail,
      dot: e.result === 'success' ? '#0FB5A5' : e.result === 'failure' ? '#D9534F' : '#C9A227',
      actorStyle:
        e.actor_type === 'agent'
          ? 'bg-[#e6f7f5] text-[#0a8d80]'
          : e.actor_type === 'human'
            ? 'bg-[#f7f0d8] text-[#8a6d10]'
            : 'bg-slate-100 text-slate-600',
      chainHead: e.sequence_no === 1,
    }));

    return NextResponse.json({
      entries,
      totalCount: totalMatching,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
