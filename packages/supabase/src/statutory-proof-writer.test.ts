import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_KEY: 'service-key',
    SUPABASE_STATUTORY_PROOF_WRITER_KEY: '',
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
  mocks.env.SUPABASE_STATUTORY_PROOF_WRITER_KEY = '';
});

describe('statutory proof writer credential', () => {
  it('refuses absent, expired and general service-role credentials', async () => {
    const { createStatutoryProofWriter } = await import('./statutory-proof-writer');
    expect(() => createStatutoryProofWriter()).toThrow(/unavailable/);
    mocks.env.SUPABASE_STATUTORY_PROOF_WRITER_KEY = token('service_role');
    expect(() => createStatutoryProofWriter()).toThrow(/Invalid/);
    mocks.env.SUPABASE_STATUTORY_PROOF_WRITER_KEY = token('statutory_proof_writer', 1);
    expect(() => createStatutoryProofWriter()).toThrow(/Invalid/);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('uses only a structurally valid restricted-role token', async () => {
    const { createStatutoryProofWriter } = await import('./statutory-proof-writer');
    const writerKey = token('statutory_proof_writer');
    mocks.env.SUPABASE_STATUTORY_PROOF_WRITER_KEY = writerKey;
    createStatutoryProofWriter();
    expect(mocks.createClient).toHaveBeenCalledWith('https://example.invalid', writerKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });
});
