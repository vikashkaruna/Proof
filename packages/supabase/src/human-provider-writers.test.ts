import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_ANON_KEY: 'public-gateway-key',
    SUPABASE_SERVICE_KEY: 'shared-service-key',
    SUPABASE_HUMAN_ACTION_WRITER_KEY: '',
    SUPABASE_EVIDENCE_INGESTION_WRITER_KEY: '',
    SUPABASE_AGENT_LEDGER_WRITER_KEY: '',
  },
  createClient: vi.fn(() => ({ rpc: vi.fn() })),
}));
vi.mock('@axiom/config', () => ({ loadEnv: () => mocks.env }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

function token(role: string, exp = Math.floor(Date.now() / 1000) + 600) {
  return `header.${Buffer.from(JSON.stringify({ role, exp })).toString('base64url')}.signature`;
}

beforeEach(() => {
  vi.resetModules();
  mocks.createClient.mockClear();
  mocks.env.SUPABASE_HUMAN_ACTION_WRITER_KEY = '';
  mocks.env.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY = '';
  mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = '';
});

describe('BFF human and provider writer credentials', () => {
  it('refuses absent, generic, cross-role and expired keys', async () => {
    const { createHumanActionWriter } = await import('./human-action-writer');
    const { createEvidenceIngestionWriter } = await import('./evidence-ingestion-writer');
    expect(() => createHumanActionWriter()).toThrow(/unavailable/);
    expect(() => createEvidenceIngestionWriter()).toThrow(/unavailable/);
    mocks.env.SUPABASE_HUMAN_ACTION_WRITER_KEY = token('service_role');
    mocks.env.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY = token('human_action_writer');
    expect(() => createHumanActionWriter()).toThrow(/Invalid/);
    expect(() => createEvidenceIngestionWriter()).toThrow(/Invalid/);
    mocks.env.SUPABASE_HUMAN_ACTION_WRITER_KEY = token('human_action_writer', 1);
    mocks.env.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY = token('evidence_ingestion_writer', 1);
    expect(() => createHumanActionWriter()).toThrow(/Invalid/);
    expect(() => createEvidenceIngestionWriter()).toThrow(/Invalid/);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('uses public apikey and distinct scoped Bearer tokens', async () => {
    const { createHumanActionWriter } = await import('./human-action-writer');
    const { createEvidenceIngestionWriter } = await import('./evidence-ingestion-writer');
    const human = token('human_action_writer');
    const provider = token('evidence_ingestion_writer');
    mocks.env.SUPABASE_HUMAN_ACTION_WRITER_KEY = human;
    mocks.env.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY = provider;
    createHumanActionWriter();
    createEvidenceIngestionWriter();
    expect(mocks.createClient).toHaveBeenNthCalledWith(
      1,
      'https://example.invalid',
      'public-gateway-key',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${human}` } },
      },
    );
    expect(mocks.createClient).toHaveBeenNthCalledWith(
      2,
      'https://example.invalid',
      'public-gateway-key',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${provider}` } },
      },
    );
  });
});

describe('agent ledger writer credential', () => {
  it('refuses absent, generic, cross-role and expired keys and never calls createClient', async () => {
    const { createAgentLedgerWriter } = await import('./agent-ledger-writer');
    expect(() => createAgentLedgerWriter()).toThrow(/unavailable/);
    mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = mocks.env.SUPABASE_SERVICE_KEY;
    expect(() => createAgentLedgerWriter()).toThrow(/unavailable/);
    mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = token('service_role');
    expect(() => createAgentLedgerWriter()).toThrow(/Invalid/);
    mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = token('human_action_writer');
    expect(() => createAgentLedgerWriter()).toThrow(/Invalid/);
    mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = token('agent_ledger_writer', 1);
    expect(() => createAgentLedgerWriter()).toThrow(/Invalid/);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('uses the public apikey with the scoped Bearer token', async () => {
    const { createAgentLedgerWriter } = await import('./agent-ledger-writer');
    const agent = token('agent_ledger_writer');
    mocks.env.SUPABASE_AGENT_LEDGER_WRITER_KEY = agent;
    createAgentLedgerWriter();
    expect(mocks.createClient).toHaveBeenCalledWith(
      'https://example.invalid',
      'public-gateway-key',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${agent}` } },
      },
    );
  });
});
