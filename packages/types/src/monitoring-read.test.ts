import { expect, it } from 'vitest';
import {
  monitoringReadScopeIntent,
  monitoringReadScopeOperation,
  encodeMonitoringReadScope,
  monitoringReadScopeContext,
} from './monitoring-read.js';
const id = '11111111-1111-4111-8111-111111111111';
const input = {
  phase: 'revoke' as const,
  request: {
    schemaVersion: 1 as const,
    operationKey: id,
    scopeId: id,
    reason: 'Explicit synthetic metadata scope revocation',
  },
};
it('canonicalizes field order while binding all decision fields', () => {
  const v = monitoringReadScopeIntent.parse(input);
  if (v.phase !== 'revoke') throw Error();
  expect(encodeMonitoringReadScope(v)).toBe(
    encodeMonitoringReadScope({
      phase: 'revoke',
      request: { reason: input.request.reason, scopeId: id, operationKey: id, schemaVersion: 1 },
    }),
  );
  expect(encodeMonitoringReadScope(v)).not.toBe(
    encodeMonitoringReadScope({
      ...v,
      request: { ...v.request, reason: 'Different explicit metadata scope revocation' },
    }),
  );
});
it('rejects private credential fields and raw TOTP in shared requests', () => {
  expect(monitoringReadScopeIntent.safeParse({ ...input, password: 'no' }).success).toBe(false);
  expect(
    monitoringReadScopeIntent.safeParse({ ...input, request: { ...input.request, code: '123456' } })
      .success,
  ).toBe(false);
});
it('requires an authoritative matching fence receipt and bounded bigint proof', () => {
  const p = {
    recorded: false,
    requestSha256: 'a'.repeat(64),
    challengeExpiresAt: null,
    fenced: true,
    fenceReceiptId: null,
  };
  expect(monitoringReadScopeOperation.safeParse(p).success).toBe(false);
  expect(
    monitoringReadScopeOperation.safeParse({ ...p, fenceReceiptId: '9223372036854775808' }).success,
  ).toBe(false);
  expect(
    monitoringReadScopeOperation.safeParse({ ...p, fenceReceiptId: '9223372036854775807' }).success,
  ).toBe(true);
});
it('does not accept untyped or incomplete history', () => {
  expect(monitoringReadScopeContext.safeParse({ tenantId: id, scopes: [] }).success).toBe(false);
});
