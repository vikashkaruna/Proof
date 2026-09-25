import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorInvocation } from '@axiom/types';
import { PostgresReadConnector, type SqlSessionFactory } from './postgres-read.js';

// Live W4.6 binding test against a disposable Postgres. CI sets both variables;
// locally the suite is skipped unless a throwaway admin URL is supplied.
const adminUrl = process.env.AXIOM_SQL_LIVE_URL;
if (process.env.AXIOM_SQL_LIVE_REQUIRED === '1' && !adminUrl)
  throw new Error('AXIOM_SQL_LIVE_URL is required for the live SQL binding job');

const context = (deadlineMs = 30_000): ConnectorInvocation => ({
  tenantId: '00000000-0000-4000-8000-000000000001',
  estateId: '00000000-0000-4000-8000-000000000002',
  systemId: '00000000-0000-4000-8000-000000000003',
  connectorId: '00000000-0000-4000-8000-000000000004',
  descriptorSha256: 'a'.repeat(64),
  grantId: '00000000-0000-4000-8000-000000000005',
  workloadIdentity: 'spiffe://test/agent/drishti',
  correlationId: '00000000-0000-4000-8000-000000000006',
  deadline: new Date(Date.now() + deadlineMs).toISOString(),
});

const PASSWORD = 'w46-live-only';
function sessionsAs(user: string): SqlSessionFactory {
  return async () => {
    const url = new URL(adminUrl!);
    url.username = user;
    url.password = user === 'postgres' ? decodeURIComponent(new URL(adminUrl!).password) : PASSWORD;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    return { query: (t, v) => client.query(t, v ? [...v] : undefined), end: () => client.end() };
  };
}

describe.skipIf(!adminUrl)('PostgresReadConnector against a live database', () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`
      drop schema if exists w46_crm cascade; drop schema if exists w46_hidden cascade;
      drop role if exists w46_reader; drop role if exists w46_writer;
      create schema w46_crm; create schema w46_hidden;
      create table w46_crm.customers (id serial primary key, email text, mobile text, pan_no text, full_name text, notes text);
      create table w46_crm.orders (id serial primary key, customer_id int, amount numeric);
      create table w46_crm.restricted (id int, secret text);
      create table w46_hidden.payroll (employee_id int, salary numeric);
      insert into w46_crm.customers (email, mobile, pan_no, full_name, notes) values
        ('asha@example.in', '+91 9876543210', 'ABCDE1234F', 'Asha Rao', 'call after 6'),
        ('ravi@example.in', '9123456780', 'PQRSX6789Z', 'Ravi K', null),
        ('not-an-email', '12345', 'bad', 'X', 'n/a');
      analyze w46_crm.customers;
      create role w46_reader login password '${PASSWORD}';
      grant usage on schema w46_crm to w46_reader;
      grant select on w46_crm.customers, w46_crm.orders to w46_reader;
      create role w46_writer login password '${PASSWORD}';
      grant usage on schema w46_crm to w46_writer;
      grant select, insert on w46_crm.orders to w46_writer;
    `);
  });
  afterAll(async () => {
    await admin.query(`
      drop schema if exists w46_crm cascade; drop schema if exists w46_hidden cascade;
      drop role if exists w46_reader; drop role if exists w46_writer;`);
    await admin.end();
  });

  const reader = new PostgresReadConnector(sessionsAs('w46_reader'));

  it('enumerates only relations the least-privilege role can see, with hints', async () => {
    const { records, cursor } = await reader.enumerate(context());
    expect(cursor).toBeUndefined();
    const resources = records.map((r) => r.resource);
    expect(resources).toEqual(['w46_crm.customers', 'w46_crm.orders']);
    const customers = records[0] as {
      categoryHints: string[];
      columns: { name: string; categoryHints: string[] }[];
    };
    expect(customers.categoryHints).toEqual(['contact', 'identity']);
    expect(customers.columns.find((c) => c.name === 'pan_no')?.categoryHints).toEqual(['identity']);
    expect(customers.columns.find((c) => c.name === 'notes')?.categoryHints).toEqual([]);
  });

  it('profiles a sample without returning any sampled value', async () => {
    const { records } = await reader.sample(context(), 'w46_crm.customers', 50);
    const byColumn = Object.fromEntries(records.map((r) => [r.column, r]));
    expect(byColumn.email).toMatchObject({ sampled: 3, nonNull: 3, detected: { email: 2 } });
    expect(byColumn.mobile).toMatchObject({ detected: { phone_in: 2 } });
    expect(byColumn.pan_no).toMatchObject({ detected: { pan: 2 } });
    expect(byColumn.notes).toMatchObject({ nonNull: 2, detected: {} });
    const serialized = JSON.stringify(records);
    for (const raw of ['asha@example.in', '9876543210', 'ABCDE1234F', 'Asha Rao', 'call after 6'])
      expect(serialized).not.toContain(raw);
  });

  it('refuses relations outside the grant and malformed input', async () => {
    await expect(reader.sample(context(), 'w46_crm.restricted', 10)).rejects.toMatchObject({
      reason: 'resource',
    });
    await expect(reader.sample(context(), 'w46_hidden.payroll', 10)).rejects.toMatchObject({
      reason: 'resource',
    });
    await expect(
      reader.sample(context(), 'w46_crm.customers; drop table x', 10),
    ).rejects.toMatchObject({ reason: 'resource' });
    await expect(reader.sample(context(), 'w46_crm.customers', 201)).rejects.toMatchObject({
      reason: 'limit',
    });
    await expect(reader.enumerate(context(), "x' or 1=1")).rejects.toMatchObject({
      reason: 'cursor',
    });
    await expect(reader.read()).rejects.toMatchObject({ reason: 'raw_read_disabled' });
    await expect(reader.enumerate(context(-1))).rejects.toMatchObject({ reason: 'deadline' });
  });

  it('refuses a role that could write or a privileged role before reading', async () => {
    await expect(
      new PostgresReadConnector(sessionsAs('w46_writer')).enumerate(context()),
    ).rejects.toMatchObject({ reason: 'write_privilege' });
    await expect(
      new PostgresReadConnector(sessionsAs('postgres')).enumerate(context()),
    ).rejects.toMatchObject({ reason: 'privileged_role' });
  });

  it('leaves no transaction or session open and cannot write even via functions', async () => {
    const opened: pg.Client[] = [];
    const tracking: SqlSessionFactory = async () => {
      const url = new URL(adminUrl!);
      url.username = 'w46_reader';
      url.password = PASSWORD;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      opened.push(client);
      return {
        query: async (t, v) => {
          // The read-only transaction rejects writes the role might reach.
          if (t.startsWith('select n.nspname as schema')) {
            await client.query('savepoint probe');
            await expect(client.query('create temp table w46_probe(x int)')).rejects.toThrow(
              /read-only transaction/,
            );
            await client.query('rollback to savepoint probe');
          }
          return client.query(t, v ? [...v] : undefined);
        },
        end: () => client.end(),
      };
    };
    await new PostgresReadConnector(tracking).enumerate(context());
    expect(opened).toHaveLength(1);
    let open = -1;
    for (let attempt = 0; attempt < 20 && open !== 0; attempt += 1) {
      const { rows } = await admin.query(
        "select count(*)::int as n from pg_stat_activity where usename = 'w46_reader'",
      );
      open = rows[0].n;
      if (open !== 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(open).toBe(0);
  });
});
