import { describe, expect, it, vi } from 'vitest';
import type { ConnectorInvocation } from '@axiom/types';
import { PostgresReadConnector, categoryHints, type SqlSession } from './postgres-read.js';
import { SqlEndpointRefused, postgresSessions, rdsIamCredentials } from './session.js';

const context: ConnectorInvocation = {
  tenantId: 't',
  estateId: 'e',
  systemId: 's',
  connectorId: 'c',
  descriptorSha256: 'a'.repeat(64),
  grantId: 'g',
  workloadIdentity: 'spiffe://test/agent/drishti',
  correlationId: 'r',
  deadline: new Date(Date.now() + 60_000).toISOString(),
};
const endpoint = {
  host: 'crm.cluster-x.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'crm',
  user: 'axiom_drishti',
  region: 'ap-south-1' as const,
  caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
};

describe('SQL session factory', () => {
  it('refuses unconfigured, non-Mumbai or CA-less endpoints before minting a credential', async () => {
    const password = vi.fn(async () => 'token');
    for (const candidate of [
      undefined,
      { ...endpoint, region: 'us-east-1' },
      { ...endpoint, caPem: undefined },
      { ...endpoint, host: 'evil host' },
      { ...endpoint, extra: true },
    ]) {
      const open = postgresSessions({
        endpoint: () => candidate as never,
        credentials: { password },
      });
      await expect(open(context)).rejects.toBeInstanceOf(SqlEndpointRefused);
    }
    expect(password).not.toHaveBeenCalled();
  });

  it('mints an IAM token per connection from the endpoint identity', async () => {
    const signer = vi.fn(() => ({ getAuthToken: async () => 'iam-token' }));
    await expect(rdsIamCredentials(signer).password(endpoint)).resolves.toBe('iam-token');
    expect(signer).toHaveBeenCalledWith(endpoint);
  });

  it('signs a real RDS IAM token offline without network access', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'offline-test-key-id';
    process.env.AWS_SECRET_ACCESS_KEY = 'example-only-not-a-secret';
    try {
      const token = await rdsIamCredentials().password(endpoint);
      expect(token.startsWith(`${endpoint.host}:5432/?`)).toBe(true);
      expect(token).toContain('Action=connect');
      expect(token).toContain('DBUser=axiom_drishti');
      expect(token).toContain('X-Amz-Expires=900');
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });
});

describe('PostgresReadConnector transaction discipline', () => {
  function fake(posture: Record<string, unknown>, failOn?: string) {
    const statements: string[] = [];
    let ended = false;
    const session: SqlSession = {
      query: async (text) => {
        statements.push(text);
        if (failOn && text.includes(failOn)) throw new Error('boom');
        if (text.includes('transaction_read_only')) return { rows: [posture] };
        return { rows: [] };
      },
      end: async () => {
        ended = true;
      },
    };
    return { open: async () => session, statements, ended: () => ended };
  }
  const safe = { read_only: true, privileged: false, can_write: false };

  it('always rolls back and closes, even when the query fails', async () => {
    const f = fake(
      safe,
      'from pg_class c join pg_namespace n on n.oid = c.relnamespace\n         left',
    );
    await expect(new PostgresReadConnector(f.open).enumerate(context)).rejects.toThrow('boom');
    expect(f.statements[0]).toBe('begin transaction isolation level repeatable read read only');
    expect(f.statements.at(-1)).toBe('rollback');
    expect(f.ended()).toBe(true);
  });

  it('bounds the statement timeout by the invocation deadline', async () => {
    const f = fake(safe);
    const soon = { ...context, deadline: new Date(Date.now() + 1200).toISOString() };
    await new PostgresReadConnector(f.open).enumerate(soon);
    const timeout = Number(/statement_timeout = (\d+)/.exec(f.statements[1]!)?.[1]);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1200);
  });

  it('fails closed on an unknown posture', async () => {
    const f = fake({ read_only: true, privileged: null, can_write: false });
    await expect(new PostgresReadConnector(f.open).enumerate(context)).rejects.toMatchObject({
      reason: 'privileged_role',
    });
    expect(f.ended()).toBe(true);
  });

  it('hints categories from column names only', () => {
    expect(categoryHints('customer_email')).toEqual(['contact']);
    expect(categoryHints('aadhaar_number')).toEqual(['identity']);
    expect(categoryHints('amount')).toEqual([]);
  });
});
