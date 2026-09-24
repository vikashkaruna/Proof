/** Synthetic credentials for the already isolated local parity stack only.
 * The signing key stays in this fixture process, never in a controller. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export function controllerCredentialFixture(tenant: string, status: Record<string, string>) {
  z.uuid().parse(tenant);
  assert.equal(new URL(status.API_URL!).port, '56321');
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const wire = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        role: 'axiom_assessment_controller',
        sub: id,
        tenant_id: tenant,
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url'),
  ].join('.');
  const accessToken = `${wire}.${createHmac('sha256', status.JWT_SECRET!).update(wire).digest('base64url')}`;
  // Generated and validated UUIDs only. No token or signing key enters SQL,
  // argv, a database row, logs or instance metadata.
  const sql = (statement: string) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        'supabase_db_axiom-w0-parity',
        'psql',
        '-X',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-q',
      ],
      { input: statement, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
    );
  sql(
    `insert into controller_security.credentials(id,tenant_id,expires_at) values('${id}','${tenant}',to_timestamp(${now + 3601}));`,
  );
  return {
    credential: JSON.stringify({ schemaVersion: 1, apiKey: status.ANON_KEY!, accessToken }),
    accessToken,
    revoke: () =>
      sql(
        `update controller_security.credentials set revoked_at=clock_timestamp() where id='${id}';`,
      ),
  };
}

/** Real Auth gateway + PostgREST + RLS, not a mock authorization response. */
export async function verifyControllerCredentialScope(
  tenant: string,
  foreign: string,
  status: Record<string, string>,
) {
  const { createClient } = await import('@supabase/supabase-js');
  const { requireControllerBackend } =
    await import('../../services/bff/src/workloads/controller-files.js');
  const fixture = controllerCredentialFixture(tenant, status);
  const db = createClient(status.API_URL!, status.ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${fixture.accessToken}` } },
  });
  try {
    await requireControllerBackend(db, tenant);
    await assert.rejects(() => requireControllerBackend(db, foreign));
    const own = await db.from('workload_identities').select('id,tenant_id');
    assert.equal(own.error, null);
    assert(own.data!.length > 0 && own.data!.every((row) => row.tenant_id === tenant));
    const other = await db
      .from('workload_identities')
      .select('id,tenant_id')
      .eq('tenant_id', foreign);
    assert.equal(other.error, null);
    assert.deepEqual(other.data, []);
    assert((await db.from('assessment_dispatch_jobs').select('ciphertext')).error);
    assert((await db.from('users').select('id')).error);
    assert(
      (await db.from('workload_identities').update({ status: 'disabled' }).eq('tenant_id', tenant))
        .error,
    );
    assert(
      (
        await db.rpc('confirm_workload_assessment', {
          p_tenant_id: foreign,
          p_run_id: randomUUID(),
        })
      ).error,
    );
    assert((await db.rpc('reserve_assessment_schedules', { p_namespace: 'fixture' })).error);
    assert((await db.rpc('purge_next_assessment_dispatch_payload', { p_tenant_id: tenant })).error);
    const tampered = fixture.accessToken.split('.');
    tampered[1] = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(tampered[1]!, 'base64url').toString()),
        tenant_id: foreign,
      }),
    ).toString('base64url');
    const forged = createClient(status.API_URL!, status.ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${tampered.join('.')}` } },
    });
    await assert.rejects(() => requireControllerBackend(forged, foreign));
    fixture.revoke();
    await assert.rejects(() => requireControllerBackend(db, tenant));
    const revoked = await db.from('workload_identities').select('id');
    assert.equal(revoked.error, null);
    assert.deepEqual(revoked.data, []);
    assert(
      (await db.rpc('confirm_workload_assessment', { p_tenant_id: tenant, p_run_id: randomUUID() }))
        .error,
    );
    return {
      'controller-backend-scoped-credential-real-signature-and-tenant-probe': true,
      'controller-backend-rls-hides-foreign-tenants': true,
      'controller-backend-private-columns-and-unrelated-tables-denied': true,
      'controller-backend-direct-writes-and-administrative-rpc-denied': true,
      'controller-backend-null-and-foreign-rpc-tenant-denied': true,
      'controller-backend-forged-signature-denied': true,
      'controller-backend-revocation-fences-reads-and-rpcs': true,
    };
  } finally {
    fixture.revoke();
  }
}
