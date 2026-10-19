import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceHttpFailure, acceptanceHttpFailureArtifact } from './acceptance-http-failure.js';
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

for (const code of [
  'report_storage_unavailable',
  'report_persistence_unconfirmed',
  'invalid_report_source',
  'invalid_request',
])
  test(`known report failure ${code} keeps only safe status and code`, () => {
    const failure = acceptanceHttpFailure(201, 503, {
      error: { code, message: 'private', jwt: 'secret' },
    });
    assert.equal(failure.errorCode, code);
    const artifact = acceptanceHttpFailureArtifact(
      'a'.repeat(40),
      'normal-auth-public-report-board-request-create',
      failure,
    );
    assert.deepEqual(
      Object.keys(artifact).sort(),
      [
        'schemaVersion',
        'kind',
        'revision',
        'phase',
        'expectedStatus',
        'actualStatus',
        'errorCode',
        'accepted',
      ].sort(),
    );
    assert.equal(artifact.accepted, false);
    assert(!JSON.stringify(artifact).includes('private'));
    assert(!JSON.stringify(artifact).includes('secret'));
  });
test('HTTP artifact refuses arbitrary revision, phase and invalid statuses', () => {
  const failure = acceptanceHttpFailure(201, 503, null);
  for (const revision of ['secret', 'a'.repeat(41)])
    assert.throws(() => acceptanceHttpFailureArtifact(revision, 'phase', failure));
  for (const phase of ['private/path', 'jwt=secret', 'a'.repeat(101)])
    assert.throws(() => acceptanceHttpFailureArtifact('a'.repeat(40), phase, failure));
  assert.throws(() =>
    acceptanceHttpFailureArtifact('a'.repeat(40), 'phase', { ...failure, actualStatus: 900 }),
  );
});
