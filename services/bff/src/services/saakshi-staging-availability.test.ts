import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ writer: vi.fn(), storage: vi.fn() }));
vi.mock('@axiom/supabase', async (original) => ({
  ...(await original<typeof import('@axiom/supabase')>()),
  createEvidenceIngestionWriter: state.writer,
}));
vi.mock('./evidence-ingestion.js', () => ({ evidenceStorage: state.storage }));
import { createSaakshiComposition } from './saakshi-staging-composition.js';
const source: NodeJS.ProcessEnv = {
  ENVIRONMENT: 'test',
  AXIOM_AUTH_MODE: 'strict',
  SUPABASE_URL: 'http://localhost:55321',
  SUPABASE_ANON_KEY: 'a'.repeat(40),
  SUPABASE_SERVICE_KEY: 'b'.repeat(40),
  APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  AXIOM_SAAKSHI_STAGE_ENABLED: 'true',
  AXIOM_SAAKSHI_PAYLOAD_KEY_ID: 'owned-v1',
  AXIOM_SAAKSHI_PAYLOAD_ENCRYPTION_KEY: '11'.repeat(32),
  AXIOM_SAAKSHI_STAGE_PEER_TOKEN: 'p'.repeat(48),
  AXIOM_SAAKSHI_STAGE_SOURCE_KEY: 's'.repeat(48),
  AGENT_RUNTIME_INTERNAL_TOKEN: 'r'.repeat(48),
  AGENT_RUNTIME_URL: 'http://127.0.0.1:8100',
};
beforeEach(() => {
  state.writer.mockReset().mockReturnValue({});
  state.storage.mockReset().mockImplementation(() => {
    throw new Error('unavailable provider');
  });
});
it.each(['missing restricted credential', 'invalid restricted role', 'expired credential'])(
  'optional incomplete setup disables the workflow without throwing: %s',
  (message) => {
    state.writer.mockImplementation(() => {
      throw new Error(message);
    });
    expect(createSaakshiComposition(source)).toBeNull();
    expect(state.storage).not.toHaveBeenCalled();
  },
);
it('provider construction failure does not disable unrelated application composition', () => {
  expect(createSaakshiComposition(source)).toBeNull();
  expect(state.writer).toHaveBeenCalledOnce();
  expect(state.storage).toHaveBeenCalledOnce();
});
it('disabled or partial configuration never constructs credentials or provider clients', () => {
  expect(createSaakshiComposition({ ...source, AXIOM_SAAKSHI_STAGE_ENABLED: 'false' })).toBeNull();
  expect(createSaakshiComposition({ ...source, AXIOM_SAAKSHI_STAGE_SOURCE_KEY: '' })).toBeNull();
  expect(state.writer).not.toHaveBeenCalled();
  expect(state.storage).not.toHaveBeenCalled();
});
