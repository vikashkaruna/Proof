import test from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  acceptancePublicWebsiteCapture,
  publicControlAcceptanceFailure,
} from './acceptance-public-control-source.js';
import { validateFreshPublicCapture } from '../../services/bff/src/connectors/public-capture-validation-v2.js';

test('synthetic transport exercises real extraction and hash-validated capture', async () => {
  const captured = await acceptancePublicWebsiteCapture(
    'https://fixture.axiomproof.ai/',
    AbortSignal.timeout(5000),
  );
  assert.equal(validateFreshPublicCapture(captured), true);
  assert.equal(captured.check.finalUrl, 'https://fixture.axiomproof.ai/');
  assert.equal(captured.evidence.pageSources.find((p) => p.page === 'privacy')?.state, 'examined');
  assert.equal(
    createHash('sha256').update(captured.evidence.payloadText).digest('hex'),
    captured.evidence.payloadSha256,
  );
  assert(captured.evidence.payloadText.includes('privacy_notice'));
});
test('fixture transport retains production URL rejection for local addresses', async () => {
  await assert.rejects(
    acceptancePublicWebsiteCapture('http://127.0.0.1/', AbortSignal.timeout(5000)),
  );
});
test('fixture does not silently capture an unrelated public host', async () => {
  await assert.rejects(
    acceptancePublicWebsiteCapture('https://unrelated.org/', AbortSignal.timeout(5000)),
  );
});

test('diagnostics omit assertion values and raw error messages', () => {
  const secret = 'synthetic-private-value';
  let failure: unknown;
  try {
    assert.equal(secret, 'other');
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(publicControlAcceptanceFailure(failure), { kind: 'assertion', path: [] });
  assert.deepEqual(publicControlAcceptanceFailure(new Error(secret)), { kind: 'error', path: [] });
  assert(!JSON.stringify(publicControlAcceptanceFailure(failure)).includes(secret));
});
test('schema diagnostics allow only fixed field labels and redact unknown paths', () => {
  const parsed = z.object({ secretField: z.string() }).safeParse({ secretField: 42 });
  assert(!parsed.success);
  assert.deepEqual(publicControlAcceptanceFailure(parsed.error), {
    kind: 'schema',
    path: ['field'],
  });
});
