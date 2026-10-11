import { expect, it } from 'vitest';
import { readSaakshiConfiguration } from './saakshi-staging-composition.js';
const configured = (): NodeJS.ProcessEnv => ({
  AXIOM_SAAKSHI_STAGE_ENABLED: 'true',
  AXIOM_SAAKSHI_PAYLOAD_KEY_ID: 'owned-key-v1',
  AXIOM_SAAKSHI_PAYLOAD_ENCRYPTION_KEY: '11'.repeat(32),
  AXIOM_SAAKSHI_STAGE_PEER_TOKEN: 'p'.repeat(48),
  AXIOM_SAAKSHI_STAGE_SOURCE_KEY: 's'.repeat(48),
  AGENT_RUNTIME_INTERNAL_TOKEN: 'r'.repeat(48),
  AGENT_RUNTIME_URL: 'http://127.0.0.1:8100',
});
it('requires explicit complete server configuration', () => {
  expect(readSaakshiConfiguration({})).toBeNull();
  expect(
    readSaakshiConfiguration({ ...configured(), AXIOM_SAAKSHI_STAGE_ENABLED: '1' }),
  ).toBeNull();
  for (const key of Object.keys(configured())) {
    const source = configured();
    delete source[key];
    expect(readSaakshiConfiguration(source)).toBeNull();
  }
});
it('keeps payload encryption, stage peer, source signature and runtime authentication independent', () => {
  for (const key of [
    'AXIOM_SAAKSHI_STAGE_PEER_TOKEN',
    'AGENT_RUNTIME_INTERNAL_TOKEN',
    'APPROVAL_SIGNING_KEY',
    'AXIOM_MFA_ENCRYPTION_KEY',
    'AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS',
    'AXIOM_PLANNING_SOURCE_SIGNING_KEY',
    'AXIOM_STORAGE_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ]) {
    expect(
      readSaakshiConfiguration({
        ...configured(),
        [key]: configured().AXIOM_SAAKSHI_STAGE_SOURCE_KEY,
      }),
    ).toBeNull();
  }
  expect(
    readSaakshiConfiguration({
      ...configured(),
      AXIOM_SAAKSHI_STAGE_PEER_TOKEN: configured().AXIOM_SAAKSHI_PAYLOAD_ENCRYPTION_KEY,
    }),
  ).toBeNull();
});
it.each([
  'ftp://runtime.invalid',
  'http://user:secret@runtime.invalid',
  'http://runtime.invalid/other',
  'http://runtime.invalid?secret=oops',
  'http://runtime.invalid/#fragment',
])('refuses runtime origin drift: %s', (url) => {
  expect(readSaakshiConfiguration({ ...configured(), AGENT_RUNTIME_URL: url })).toBeNull();
});
it('retains independent byte key and explicit provider retention choices', () => {
  const config = readSaakshiConfiguration({
    ...configured(),
    AXIOM_SAAKSHI_LEGAL_HOLD: 'true',
    AXIOM_SAAKSHI_ENCRYPTION: 'aws:kms',
  });
  expect(config?.key.key).toEqual(Buffer.from('11'.repeat(32), 'hex'));
  expect(config?.key.id).toBe('owned-key-v1');
  expect(config?.legalHold).toBe('true');
  expect(config?.encryption).toBe('aws:kms');
});
it.each([
  'AXIOM_SAAKSHI_LEGAL_HOLD',
  'AXIOM_SAAKSHI_ENCRYPTION',
  'AXIOM_SAAKSHI_PAYLOAD_ENCRYPTION_KEY',
])(
  'malformed retention/key configuration does not enable a partially valid workflow: %s',
  (key) => {
    expect(readSaakshiConfiguration({ ...configured(), [key]: 'invalid' })).toBeNull();
  },
);
