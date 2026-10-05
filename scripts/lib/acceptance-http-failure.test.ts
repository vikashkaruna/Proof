import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceHttpFailure } from './acceptance-http-failure.js';
test('retains exact statuses and known code while dropping confidential response fields', () => {
  assert.deepEqual(
    acceptanceHttpFailure(404, 503, {
      error: { code: 'assessment_request_unconfirmed', message: 'private', token: 'secret' },
      session: 'secret',
    }),
    { expectedStatus: 404, actualStatus: 503, errorCode: 'assessment_request_unconfirmed' },
  );
});
for (const body of [
  null,
  'private',
  [],
  { error: 'secret' },
  { error: { code: 'secret' } },
  { error: { code: 401 } },
])
  test(`unrecognized diagnostic shape ${JSON.stringify(body)}`, () => {
    assert.deepEqual(acceptanceHttpFailure(200, 401, body), {
      expectedStatus: 200,
      actualStatus: 401,
      errorCode: 'unrecognized',
    });
  });
for (const status of [NaN, Infinity, 99, 600, 200.5])
  test(`refuses invalid HTTP status ${status}`, () => {
    assert.throws(() => acceptanceHttpFailure(200, status, null));
    assert.throws(() => acceptanceHttpFailure(status, 200, null));
  });
