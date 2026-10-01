import { describe, expect, it } from 'vitest';
import { createE2ESupabaseClient } from './e2e';

const fixture = () => createE2ESupabaseClient('reviewer@example.invalid');

describe('explicit local/test Supabase fixture', () => {
  it('keeps a deterministic user session through auth operations', async () => {
    const client = fixture();
    expect((await client.auth.getUser()).data.user?.email).toBe('reviewer@example.invalid');
    expect((await client.auth.getSession()).data.session?.access_token).toBe('test-access-token');
    expect(
      (
        await client.auth.signInWithPassword({
          email: 'reviewer@example.invalid',
          password: 'fixture',
        })
      ).data.user?.email,
    ).toBe('reviewer@example.invalid');
    expect(
      (await client.auth.signUp({ email: 'reviewer@example.invalid', password: 'fixture' })).data
        .user?.email,
    ).toBe('reviewer@example.invalid');
    expect(
      (await client.auth.updateUser({ data: { full_name: 'Reviewer' } })).data.user?.user_metadata,
    ).toMatchObject({ full_name: 'Reviewer' });
    expect((await client.auth.resetPasswordForEmail('reviewer@example.invalid')).error).toBeNull();
    expect((await client.auth.signOut()).error).toBeNull();
    const subscription = client.auth.onAuthStateChange(() => {});
    expect(subscription.data.subscription.id).toBe('mock-sub');
    subscription.data.subscription.unsubscribe();
    expect(await client.rpc('fixture_rpc')).toEqual({ data: [], error: null });
  });

  it('provides only fixed local fixture rows and filters by tenant', async () => {
    const client = fixture();
    const tenant = await client.from('tenants').select('*').eq('slug', 'demo-client').maybeSingle();
    expect(tenant.data).toMatchObject({ slug: 'demo-client' });
    const unknown = await client
      .from('tenants')
      .select('*')
      .eq('slug', 'unrelated-tenant')
      .maybeSingle();
    expect(unknown.data).toBeNull();
    const rows = await client.from('tenants').select('*').eq('slug', 'unrelated-tenant');
    expect(rows.data).toEqual([]);
    expect((await client.from('users').select('*').single()).data).toMatchObject({
      email: 'founder@axiomminds.ai',
    });
    expect((await client.from('remediation_plans').select('*').single()).data).toMatchObject({
      status: 'draft',
    });
    expect((await client.from('audit_ledger').select('*').single()).data).toMatchObject({
      sequence_no: 1,
    });
    expect((await client.from('unknown_table').select('*').single()).error).toMatchObject({
      code: 'PGRST116',
    });
  });

  it('retains fixture insert/upsert and allows filtered reads without reaching a provider', async () => {
    const client = fixture();
    const table = 'w9-fixture-only';
    const row = { id: 'row-w9-a', tenant_id: 'tenant-a', status: 'draft' };
    expect((await client.from(table).insert(row).select('*').single()).data).toMatchObject(row);
    expect((await client.from(table).select('*').eq('tenant_id', 'tenant-a')).data).toEqual([row]);
    expect((await client.from(table).select('*').eq('tenant_id', 'tenant-b')).data).toEqual([]);
    const updated = { ...row, status: 'reviewed' };
    expect((await client.from(table).upsert(updated).select('*').single()).data).toMatchObject(
      updated,
    );
    expect(
      (await client.from(table).select('*').eq('status', 'reviewed').maybeSingle()).data,
    ).toMatchObject(updated);
    expect(
      (await client.from(table).update({ status: 'sealed' }).select('*').single()).data,
    ).toMatchObject({ status: 'sealed' });
    expect((await client.from(table).delete()).error).toBeNull();
  });
});
