import { describe, expect, it } from 'vitest';
import { assertConfiguredHumanRetentionApproval } from './saakshi-human-retention-approval.js';
const config = {
  provider: 's3-compatible',
  bucket: 'owned-fixture',
  lockMode: 'COMPLIANCE',
  retentionPolicy: 'seven_years',
  encryption: 'AES256',
  legalHold: false,
};
describe('explicit configured immutable retention approval (unwired)', () => {
  it('preserves exact human acknowledged target, retention and false legal hold', () => {
    expect(
      assertConfiguredHumanRetentionApproval(
        { ...config, acknowledgesImmutableRetention: true },
        config,
      ),
    ).toEqual({ ...config, acknowledgesImmutableRetention: true });
  });
  it.each([undefined, false, 0, 1, 'true'])('does not infer acknowledgement from %j', (ack) => {
    expect(() =>
      assertConfiguredHumanRetentionApproval(
        { ...config, acknowledgesImmutableRetention: ack },
        config,
      ),
    ).toThrow();
  });
  it.each([
    'provider',
    'bucket',
    'lockMode',
    'retentionPolicy',
    'encryption',
    'legalHold',
  ] as const)('refuses missing approved %s rather than defaulting server values', (field) => {
    const approval: Record<string, unknown> = { ...config, acknowledgesImmutableRetention: true };
    delete approval[field];
    expect(() => assertConfiguredHumanRetentionApproval(approval, config)).toThrow();
  });
  it.each([
    { bucket: 'foreign-bucket' },
    { provider: 's3' },
    { lockMode: 'GOVERNANCE' },
    { retentionPolicy: 'one_day' },
    { encryption: 'aws:kms' },
    { legalHold: true },
  ])('refuses configuration drift %j', (change) => {
    expect(() =>
      assertConfiguredHumanRetentionApproval(
        { ...config, ...change, acknowledgesImmutableRetention: true },
        config,
      ),
    ).toThrow();
  });
  it('refuses arbitrary target URLs and hidden caller fields', () => {
    expect(() =>
      assertConfiguredHumanRetentionApproval(
        { ...config, acknowledgesImmutableRetention: true, origin: 'http://private.invalid' },
        config,
      ),
    ).toThrow();
  });
});
