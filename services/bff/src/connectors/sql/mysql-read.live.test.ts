import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorInvocation } from '@axiom/types';
import { MySqlReadConnector } from './mysql-read.js';
import type { SqlSessionFactory } from './postgres-read.js';

// Live W4.6 MySQL binding test against a disposable MySQL 8 server. CI sets
// both variables; locally the suite is skipped unless a throwaway admin URL is
// supplied.
const adminUrl = process.env.AXIOM_MYSQL_LIVE_URL;
if (process.env.AXIOM_MYSQL_LIVE_REQUIRED === '1' && !adminUrl)
  throw new Error('AXIOM_MYSQL_LIVE_URL is required for the live MySQL binding job');

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
function openAs(user: string): Promise<mysql.Connection> {
  const url = new URL(adminUrl!);
  return mysql.createConnection({
    host: url.hostname,
    port: Number(url.port) || 3306,
    user,
    password: user === 'root' ? decodeURIComponent(url.password) : PASSWORD,
    dateStrings: true,
  });
}
function sessionsAs(user: string): SqlSessionFactory {
  return async () => {
    const connection = await openAs(user);
    return {
      query: async (text, values) => {
        const [result] = await connection.query({
          sql: text,
          values: values ? [...values] : undefined,
        });
        return { rows: Array.isArray(result) ? (result as Record<string, unknown>[]) : [] };
      },
      end: async () => {
        await connection.end();
      },
    };
  };
}

describe.skipIf(!adminUrl)('MySqlReadConnector against a live database', () => {
  let admin: mysql.Connection;
  beforeAll(async () => {
    admin = await openAs('root');
    const statements = [
      'drop database if exists w46_crm',
      'drop database if exists w46_hidden',
      "drop user if exists 'w46_reader'@'%'",
      "drop user if exists 'w46_writer'@'%'",
      "drop user if exists 'w46_super'@'%'",
      'create database w46_crm',
      'create database w46_hidden',
      `create table w46_crm.customers (
         id int auto_increment primary key, email text, mobile text,
         pan_no text, full_name text, notes text)`,
      'create table w46_crm.orders (id int auto_increment primary key, customer_id int, amount decimal(10,2))',
      'create table w46_crm.restricted (id int, secret text)',
      'create table w46_hidden.payroll (employee_id int, salary decimal(10,2))',
      `insert into w46_crm.customers (email, mobile, pan_no, full_name, notes) values
         ('asha@example.in', '+91 9876543210', 'ABCDE1234F', 'Asha Rao', 'call after 6'),
         ('ravi@example.in', '9123456780', 'PQRSX6789Z', 'Ravi K', null),
         ('not-an-email', '12345', 'bad', 'X', 'n/a')`,
      "create user 'w46_reader'@'%' identified by 'w46-live-only'",
      "grant select on w46_crm.customers to 'w46_reader'@'%'",
      "grant select on w46_crm.orders to 'w46_reader'@'%'",
      "create user 'w46_writer'@'%' identified by 'w46-live-only'",
      "grant select on w46_crm.orders to 'w46_writer'@'%'",
      "grant insert on w46_crm.orders to 'w46_writer'@'%'",
      "create user 'w46_super'@'%' identified by 'w46-live-only'",
      "grant select, super on *.* to 'w46_super'@'%'",
    ];
    for (const statement of statements) await admin.query(statement);
  });
  afterAll(async () => {
    if (!admin) return;
    for (const statement of [
      'drop database if exists w46_crm',
      'drop database if exists w46_hidden',
      "drop user if exists 'w46_reader'@'%'",
      "drop user if exists 'w46_writer'@'%'",
      "drop user if exists 'w46_super'@'%'",
    ])
      await admin.query(statement);
    await admin.end();
  });

  const reader = new MySqlReadConnector(sessionsAs('w46_reader'));

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
      new MySqlReadConnector(sessionsAs('w46_writer')).enumerate(context()),
    ).rejects.toMatchObject({ reason: 'write_privilege' });
    await expect(
      new MySqlReadConnector(sessionsAs('w46_super')).enumerate(context()),
    ).rejects.toMatchObject({ reason: 'privileged_role' });
  });

  it('runs read-only, rolls back, and leaves no session open', async () => {
    const opened: mysql.Connection[] = [];
    const tracking: SqlSessionFactory = async () => {
      const connection = await openAs('w46_reader');
      opened.push(connection);
      return {
        query: async (text, values) => {
          // The session-level read-only mode and its server-side verification
          // are part of the binding; DML the role holds no grant for is refused
          // regardless.
          if (text.startsWith('select t.table_schema as tschema')) {
            const [probe] = await connection.query('select @@session.transaction_read_only as ro');
            expect((probe as mysql.RowDataPacket[])[0]?.ro).toBe(1);
            await expect(
              connection.query("insert into w46_crm.customers (email) values ('probe')"),
            ).rejects.toThrow();
          }
          const [result] = await connection.query({
            sql: text,
            values: values ? [...values] : undefined,
          });
          return { rows: Array.isArray(result) ? (result as Record<string, unknown>[]) : [] };
        },
        end: async () => {
          await connection.end();
        },
      };
    };
    await new MySqlReadConnector(tracking).enumerate(context());
    expect(opened).toHaveLength(1);
    let open = -1;
    for (let attempt = 0; attempt < 20 && open !== 0; attempt += 1) {
      const [rows] = await admin.query(
        "select count(*) as n from information_schema.processlist where user = 'w46_reader'",
      );
      open = Number((rows as mysql.RowDataPacket[])[0]?.n);
      if (open !== 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(open).toBe(0);
  });
});
