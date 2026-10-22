/**
 * LOCAL-ONLY enrollment of the three synthetic demo databases as sandbox SQL
 * connectors (scripts/local-demo-databases.py must be up first).
 *
 *   tsx scripts/local-connector-sandbox.ts enroll --issuer-node-id <spiffe id> [--days 30]
 *   tsx scripts/local-connector-sandbox.ts status
 *   tsx scripts/local-connector-sandbox.ts revoke
 *
 * Every step goes through the reviewed database paths, never direct table
 * writes: the estate system, connector registration and activation, the
 * Drishti workload registration and read grant are human RPCs recorded with
 * the named persona owner (never the owner's own accounts); the sandbox
 * enrollment is the immutable operator row under each tenant's active custody
 * policy. The BFF sandbox configuration and its pinned credential files are
 * written 0600 under .axiom-runtime/sql-sandbox, to be mounted read-only at
 * /etc/axiom/sql-sandbox. Passwords are read from the demo database state and
 * never printed. The configuration digest is computed by the same code the
 * BFF verifies with (sandboxConfigurationSha256).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { connectorRegistry } from '../src/connectors/registry.js';
import {
  SandboxPostgresqlConfiguration,
  sandboxConfigurationSha256,
} from '../src/connectors/postgresql-sandbox.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RUNTIME = process.env.AXIOM_RUNTIME_DIR ?? join(ROOT, '.axiom-runtime');
const DEMO = join(RUNTIME, 'demo-targets');
const OUT = join(RUNTIME, 'sql-sandbox');
const MOUNT = '/etc/axiom/sql-sandbox';
const DRISHTI = 'spiffe://local.axiomproof.test/agent/drishti';
const DB_URL =
  process.env.AXIOM_LOCAL_DB_URL ?? 'postgresql://supabase_admin:postgres@127.0.0.1:57122/postgres';
const ACTOR_EMAIL =
  process.env.AXIOM_SANDBOX_ACTOR_EMAIL ?? 'persona-owner-mfa-7ad82341@example.invalid';

const TARGETS = [
  {
    tenantSlug: 'demo-kosha-bfsi',
    estateName: 'Kosha lending and payments estate',
    system: 'Core Banking Ledger (PostgreSQL)',
    systemKind: 'database',
    connector: 'Kosha core banking — PostgreSQL',
    endpointRef: 'kosha_core_banking_pg',
    descriptorId: '41410000-0000-4000-8000-000000000003',
    host: 'axiom-pg-kosha-core',
    port: 5432,
    database: 'kosha_core',
  },
  {
    tenantSlug: 'demo-sanjeevani-health',
    estateName: 'Sanjeevani clinical and patient estate',
    system: 'Hospital Information System (MySQL)',
    systemKind: 'database',
    connector: 'Sanjeevani HIS — MySQL',
    endpointRef: 'sanjeevani_his_mysql',
    descriptorId: '41420000-0000-4000-8000-000000000003',
    host: 'axiom-mysql-sanjeevani-his',
    port: 3306,
    database: 'his',
  },
  {
    tenantSlug: 'demo-nimbus-saas',
    estateName: 'Nimbus HR and payroll platform',
    system: 'SaaS Application Database (MariaDB)',
    systemKind: 'database',
    connector: 'Nimbus app database — MariaDB',
    endpointRef: 'nimbus_app_mariadb',
    descriptorId: '41430000-0000-4000-8000-000000000003',
    host: 'axiom-mariadb-nimbus-app',
    port: 3306,
    database: 'app',
  },
] as const;

type Client = pg.PoolClient | pg.Client;
const one = async <T extends Record<string, unknown>>(db: Client, sql: string, values: unknown[]) =>
  (await db.query(sql, values)).rows[0] as T | undefined;

function writePrivate(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Call a human RPC as the constrained writer role, the way the BFF does. */
async function human(db: Client, fn: string, args: unknown[]): Promise<Record<string, unknown>> {
  await db.query('begin');
  try {
    await db.query('set local role human_action_writer');
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await db.query(`select public.${fn}(${placeholders}) as r`, args);
    await db.query('commit');
    const result = rows[0]?.r as Record<string, unknown>;
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

function approvalReference(): string {
  const file = join(OUT, 'approval.private.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).approvalReference;
  const record = {
    approvalReference: randomUUID(),
    recordedAt: new Date().toISOString(),
    source: 'owner chat request, 2026-10-22',
    request:
      'Continue with database connectors for PostgreSQL, MySQL and MariaDB. Establish it with existing demo companies, three select different ones. Build sample related audit scans and reporting. All these need to be tested thoroughly for its working.',
    scope: 'local synthetic demo databases only; sandbox read discovery by Drishti',
  };
  writePrivate(file, record);
  return record.approvalReference;
}

async function enroll(issuerNodeId: string, days: number) {
  if (!/^spiffe:\/\/local\.axiomproof\.test\/spire\/agent\/[^\s]+$/.test(issuerNodeId))
    throw new Error('--issuer-node-id must be the local SPIRE agent ID');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be 1..90');
  mkdirSync(join(OUT, 'credentials'), { recursive: true, mode: 0o700 });
  chmodSync(OUT, 0o700);
  chmodSync(join(OUT, 'credentials'), 0o700);
  const approval = approvalReference();
  const expiresAt = Date.now() + days * 86_400_000;
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const actor = await one<{ id: string }>(db, 'select id from public.users where email=$1', [
      ACTOR_EMAIL,
    ]);
    if (!actor) throw new Error('Persona owner account not found');
    const connections = [];
    const enrollments = [];
    for (const target of TARGETS) {
      const tenant = await one<{ id: string }>(
        db,
        'select id from public.tenants where slug=$1 and is_demo',
        [target.tenantSlug],
      );
      if (!tenant) throw new Error(`Demo tenant ${target.tenantSlug} not found`);
      const estate = await one<{ id: string }>(
        db,
        "select id from public.estates where tenant_id=$1 and name=$2 and status='active'",
        [tenant.id, target.estateName],
      );
      if (!estate) throw new Error(`Active estate missing for ${target.tenantSlug}`);
      const correlation = () => randomUUID();
      let system = await one<{ id: string }>(
        db,
        'select id from public.estate_systems where tenant_id=$1 and estate_id=$2 and name=$3',
        [tenant.id, estate.id, target.system],
      );
      if (!system) {
        const created = await human(db, 'manage_estate', [
          tenant.id,
          actor.id,
          'system.create',
          estate.id,
          {
            name: target.system,
            systemKind: target.systemKind,
            description: 'Synthetic demonstration database (local only).',
          },
          correlation(),
        ]);
        if (created.error) throw new Error(`system.create: ${String(created.error)}`);
        system = await one(
          db,
          'select id from public.estate_systems where tenant_id=$1 and name=$2',
          [tenant.id, target.system],
        );
      }
      const manifest = connectorRegistry.get(target.descriptorId);
      if (!manifest) throw new Error(`Descriptor ${target.descriptorId} is not reviewed`);
      let connector = await one<{ id: string; status: string; version: number }>(
        db,
        'select id,status,version from public.connectors where tenant_id=$1 and system_id=$2 and endpoint_ref=$3',
        [tenant.id, system!.id, target.endpointRef],
      );
      if (!connector) {
        const created = await human(db, 'manage_connector', [
          tenant.id,
          actor.id,
          'create',
          null,
          {
            systemId: system!.id,
            descriptorId: target.descriptorId,
            name: target.connector,
            endpointRef: target.endpointRef,
          },
          manifest,
          correlation(),
        ]);
        if (created.error) throw new Error(`connector.create: ${String(created.error)}`);
        connector = await one(
          db,
          'select id,status,version from public.connectors where tenant_id=$1 and system_id=$2 and endpoint_ref=$3',
          [tenant.id, system!.id, target.endpointRef],
        );
      }
      if (connector!.status !== 'active') {
        const activated = await human(db, 'manage_connector', [
          tenant.id,
          actor.id,
          'transition',
          connector!.id,
          { expectedVersion: connector!.version, status: 'active' },
          null,
          correlation(),
        ]);
        if (activated.error) throw new Error(`connector.activate: ${String(activated.error)}`);
      }
      connector = await one(db, 'select id,status,version from public.connectors where id=$1', [
        connector!.id,
      ]);
      let workload = await one<{ id: string; status: string; version: number }>(
        db,
        "select id,status,version from public.workload_identities where tenant_id=$1 and agent_name='drishti' and spiffe_id=$2",
        [tenant.id, DRISHTI],
      );
      if (!workload) {
        const id = randomUUID();
        const registered = await human(db, 'manage_workload_identity', [
          tenant.id,
          actor.id,
          correlation(),
          id,
          0,
          'drishti',
          DRISHTI,
          'disabled',
        ]);
        if (registered.error) throw new Error(`workload.register: ${String(registered.error)}`);
        workload = await one(
          db,
          'select id,status,version from public.workload_identities where id=$1',
          [id],
        );
      }
      if (workload!.status !== 'active') {
        const activated = await human(db, 'manage_workload_identity', [
          tenant.id,
          actor.id,
          correlation(),
          workload!.id,
          workload!.version,
          'drishti',
          DRISHTI,
          'active',
        ]);
        if (activated.error) throw new Error(`workload.activate: ${String(activated.error)}`);
      }
      const grant = await human(db, 'issue_connector_grant', [
        tenant.id,
        actor.id,
        connector!.id,
        workload!.id,
        'connector.read',
        ['sql.enumerate', 'sql.sample'],
        Math.min(90, days),
        correlation(),
      ]);
      if (grant.error && grant.error !== 'grant_exists')
        throw new Error(`grant.issue: ${String(grant.error)}`);
      const descriptor = await one<{ content_sha256: string }>(
        db,
        'select content_sha256 from public.connector_descriptors where id=$1',
        [target.descriptorId],
      );
      const custody = await one<{ policy_id: string; activation_epoch: string }>(
        db,
        "select policy_id,activation_epoch from public.local_custody_policy_heads where tenant_id=$1 and state='active'",
        [tenant.id],
      );
      if (!descriptor || !custody)
        throw new Error(`Descriptor or custody missing for ${target.tenantSlug}`);
      const previous = await one<{ n: string }>(
        db,
        'select count(*) n from public.postgresql_sandbox_deployments where tenant_id=$1 and connector_id=$2',
        [tenant.id, connector!.id],
      );
      const credential = {
        id: randomUUID(),
        revision: Number(previous?.n ?? 0) + 1,
        expiresAt,
        file: `${MOUNT}/credentials/${connector!.id}.json`,
      };
      writePrivate(join(OUT, 'credentials', `${connector!.id}.json`), {
        schemaVersion: 1,
        tenantId: tenant.id,
        connectorId: connector!.id,
        credentialId: credential.id,
        revision: credential.revision,
        expiresAt,
        password: readFileSync(
          join(DEMO, target.host, 'axiom_discovery_ro.password'),
          'utf8',
        ).trim(),
      });
      connections.push({
        binding: {
          tenantId: tenant.id,
          estateId: estate.id,
          connectorId: connector!.id,
          systemId: system!.id,
          descriptorId: target.descriptorId,
          descriptorSha256: descriptor.content_sha256,
          endpointRef: target.endpointRef,
          targetBinding: 'sandbox',
          connectorVersion: connector!.version,
        },
        endpoint: {
          host: target.host,
          port: target.port,
          database: target.database,
          user: 'axiom_discovery_ro',
          region: 'ap-south-1',
          caPem: readFileSync(join(DEMO, target.host, 'tls', 'ca.pem'), 'utf8'),
        },
        credential,
      });
      enrollments.push({
        tenantId: tenant.id,
        connectorId: connector!.id,
        descriptor,
        custody,
        target,
      });
    }
    const configuration = SandboxPostgresqlConfiguration.parse({
      schemaVersion: 1,
      mode: 'local_sandbox_password',
      environment: 'local',
      workload: {
        socketPath: '/run/workload/api.sock',
        issuerNodeId,
        healthFile: '/run/spire-health/status.json',
        trustDomain: 'local.axiomproof.test',
      },
      connections,
    });
    const digest = sandboxConfigurationSha256(configuration);
    await db.query('begin');
    try {
      await db.query('set local role axiom_sandbox_connector_operator');
      for (const e of enrollments) {
        // Supersede earlier enrollments of the same connector (revocation is one-way).
        await db.query(
          'update public.postgresql_sandbox_deployments set revoked_at=clock_timestamp() where tenant_id=$1 and connector_id=$2 and revoked_at is null',
          [e.tenantId, e.connectorId],
        );
        await db.query(
          `insert into public.postgresql_sandbox_deployments(configuration_sha256,tenant_id,connector_id,descriptor_sha256,
            endpoint_ref,environment,disposable_target,approval_reference,custody_policy_id,custody_activation_epoch,expires_at)
           values($1,$2,$3,$4,$5,'local',true,$6,$7,$8,to_timestamp($9::double precision/1000))`,
          [
            digest,
            e.tenantId,
            e.connectorId,
            e.descriptor.content_sha256,
            e.target.endpointRef,
            approval,
            e.custody.policy_id,
            e.custody.activation_epoch,
            expiresAt,
          ],
        );
      }
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
    writePrivate(join(OUT, 'config.json'), configuration);
    console.log(
      `Enrolled ${enrollments.length} sandbox connectors; configuration ${digest.slice(0, 12)}`,
    );
    console.log(
      `Valid until ${new Date(expiresAt).toISOString()}; mount ${OUT} read-only at ${MOUNT}`,
    );
    console.log(`BFF: AXIOM_POSTGRESQL_SANDBOX_CONFIG_FILE=${MOUNT}/config.json`);
  } finally {
    await db.end();
  }
}

async function status() {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      `select t.slug, c.name, c.status, d.manifest->>'target' engine, s.expires_at, s.revoked_at,
         left(s.configuration_sha256,12) config,
         exists(select 1 from public.connector_grants g where g.tenant_id=c.tenant_id and g.connector_id=c.id
           and g.revoked_at is null and g.expires_at>now()) grant_active
       from public.postgresql_sandbox_deployments s
       join public.connectors c on c.tenant_id=s.tenant_id and c.id=s.connector_id
       join public.connector_descriptors d on d.id=c.descriptor_id
       join public.tenants t on t.id=s.tenant_id order by t.slug, s.expires_at desc`,
    );
    console.table(rows);
  } finally {
    await db.end();
  }
}

async function revoke() {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('set local role axiom_sandbox_connector_operator');
    const { rowCount } = await db.query(
      `update public.postgresql_sandbox_deployments set revoked_at=clock_timestamp()
       where revoked_at is null and endpoint_ref = any($1)`,
      [TARGETS.map((t) => t.endpointRef)],
    );
    await db.query('commit');
    console.log(`Revoked ${rowCount} sandbox enrollments.`);
  } finally {
    await db.end();
  }
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
try {
  if (command === 'enroll')
    await enroll(flag('--issuer-node-id') ?? '', Number(flag('--days') ?? 30));
  else if (command === 'status') await status();
  else if (command === 'revoke') await revoke();
  else throw new Error('Usage: enroll --issuer-node-id <id> [--days N] | status | revoke');
} catch (error) {
  // Messages here never contain a password: they are fixed strings or RPC error codes.
  console.error(error instanceof Error ? error.message : 'Sandbox enrollment failed');
  process.exitCode = 1;
}
