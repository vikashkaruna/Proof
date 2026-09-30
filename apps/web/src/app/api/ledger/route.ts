import { NextResponse, type NextRequest } from 'next/server';
import { requireTenantContext } from '@/lib/tenant-context';
import { isSafeLedgerSearch, ledgerPageNumber } from '@/lib/ledger-search';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Let the shared session/tenant gate redirect or refuse on its own terms.
  // Catching that control flow below would turn an auth failure into a 500.
  const { supabase, tenantId } = await requireTenantContext();
  try {
    const { searchParams } = new URL(request.url);
    // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
    // by design, and these queries carried no tenant filter, so any
    // authenticated user saw every tenant's data. The client below is
    // user-scoped: RLS applies, and the explicit filters state the intent.

    const isExport = searchParams.get('export') === 'true';
    const agent = searchParams.get('agent');
    const action = searchParams.get('action');
    const result = searchParams.get('result');
    const q = searchParams.get('q')?.trim();
    if (q && !isSafeLedgerSearch(q)) {
      return NextResponse.json({ error: 'Invalid ledger search query' }, { status: 400 });
    }

    // The session membership gate selects the tenant. An explicit tenant must match it.
    const requestedTenantId =
      searchParams.get('tenantId') ||
      searchParams.get('tenant_id') ||
      request.headers.get('x-tenant-id');
    if (requestedTenantId && requestedTenantId !== tenantId) {
      return NextResponse.json({ error: 'Tenant mismatch' }, { status: 403 });
    }

    const { data: targetTenant } = await supabase
      .from('tenants')
      .select('id, name, slug')
      .eq('id', tenantId)
      .maybeSingle();

    // ─── AUDITOR EXPORT HANDLER ──────────────────────────────────────────────
    if (isExport) {
      if (!targetTenant) {
        return NextResponse.json({ error: 'Unable to verify the export tenant' }, { status: 503 });
      }
      let exportQuery = supabase
        .from('audit_ledger')
        .select('*', { count: 'exact' })
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

      const { data: records, count: availableRecordCount, error: exportError } = await exportQuery;
      if (exportError) {
        return NextResponse.json({ error: exportError.message }, { status: 500 });
      }
      if (
        !Array.isArray(records) ||
        typeof availableRecordCount !== 'number' ||
        !Number.isInteger(availableRecordCount) ||
        availableRecordCount < 0
      ) {
        return NextResponse.json({ error: 'Ledger export source is unavailable' }, { status: 503 });
      }

      // Verify chain integrity for the target tenant
      let chainIntact = true;
      let firstBreak = null;
      const { data: verifyData, error: verifyError } = await supabase.rpc('verify_ledger', {
        p_tenant_id: targetTenant.id,
        p_from_sequence: 1,
      });
      if (verifyError || !Array.isArray(verifyData)) {
        return NextResponse.json({ error: 'Ledger verification is unavailable' }, { status: 503 });
      }
      if (verifyData.length > 0) {
        chainIntact = false;
        firstBreak = verifyData[0];
      }

      const entriesList = records;
      const firstExportedRecord = entriesList[0];
      const lastExportedRecord = entriesList[entriesList.length - 1];

      const auditBundle = {
        export_metadata: {
          format: 'Axiom Proof audit ledger export',
          cryptographic_specification: 'SHA-256 hash-chain verification (ADR-5)',
          platform: 'Axiom Proof — Agentic DPDPA Compliance Platform',
          exported_at: new Date().toISOString(),
          tenant: {
            id: targetTenant.id,
            name: targetTenant.name,
            slug: targetTenant.slug,
          },
          chain_integrity: {
            status: chainIntact ? 'intact' : 'broken',
            verified: chainIntact,
            scope: 'full tenant ledger from genesis',
            first_break: firstBreak,
          },
          total_records: entriesList.length,
          total_records_available: availableRecordCount,
          export_truncated:
            availableRecordCount === null || availableRecordCount > entriesList.length,
          first_exported_sequence: firstExportedRecord?.sequence_no ?? null,
          last_exported_sequence: lastExportedRecord?.sequence_no ?? null,
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
      const filename = `axiom-proof-audit-ledger-${targetTenant.slug}-${dateStr}.json`;

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
    const page = ledgerPageNumber(searchParams.get('page'), 1, 1_000_000);
    const limit = Math.max(5, ledgerPageNumber(searchParams.get('limit'), 25, 100));

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

    if (
      !Array.isArray(data) ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      return NextResponse.json({ error: 'Ledger records are unavailable' }, { status: 503 });
    }

    const totalMatching = count;
    const totalPages = Math.max(1, Math.ceil(totalMatching / limit));

    const entries = data.map((e) => ({
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
        : 'Unknown time',
      corr: e.correlation_id ? `cr-${e.correlation_id.slice(0, 4)}` : 'No correlation ID',
      fullCorr: e.correlation_id || '',
      target: e.target_ref || 'No target recorded',
      entryHash: e.entry_hash
        ? `${e.entry_hash.slice(0, 4)}…${e.entry_hash.slice(-3)}`
        : 'Unavailable',
      fullEntryHash: e.entry_hash || '',
      prevHash: e.prev_entry_hash
        ? `${e.prev_entry_hash.slice(0, 4)}…${e.prev_entry_hash.slice(-3)}`
        : 'Genesis or unavailable',
      fullPrevHash: e.prev_entry_hash || '',
      result: e.result || 'unknown',
      detail: e.detail,
      dot: e.result === 'success' ? '#0FB5A5' : e.result === 'failure' ? '#D9534F' : '#64748B',
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
  } catch {
    return NextResponse.json({ error: 'Ledger service unavailable' }, { status: 503 });
  }
}
