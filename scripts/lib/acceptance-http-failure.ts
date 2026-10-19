/** Private harness diagnostics only. Never retain a raw response or arbitrary error text. */
const codes = new Set([
  'validation_failed',
  'report_storage_unavailable',
  'report_persistence_unconfirmed',
  'invalid_report_source',
  'invalid_request',
  'invalid_assessment_request',
  'expected_actor_required',
  'assessment_actor_changed',
  'assessment_operation_key_mismatch',
  'assessment_requests_unavailable',
  'assessment_questionnaire_mismatch',
  'assessment_engagement_not_found',
  'assessment_already_recorded',
  'assessment_request_unconfirmed',
  'role_forbidden',
  'scope_forbidden',
  'tenant_forbidden',
  'mfa_enrolment_required',
  'mfa_verification_required',
  'session_unidentified',
  'code_rejected',
  'challenge_not_found',
  'rate_limited',
  'idempotency_unavailable',
  'idempotency_outcome_unknown',
]);
export function acceptanceHttpFailure(expected: number, actual: number, body: unknown) {
  if (
    ![expected, actual].every(
      (status) => Number.isInteger(status) && status >= 100 && status <= 599,
    )
  )
    throw new Error('Invalid diagnostic status');
  let code: unknown;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>).error;
    if (error && typeof error === 'object' && !Array.isArray(error))
      code = (error as Record<string, unknown>).code;
  }
  return Object.freeze({
    expectedStatus: expected,
    actualStatus: actual,
    errorCode: typeof code === 'string' && codes.has(code) ? code : 'unrecognized',
  });
}

/** Public fixture artifact: explicit safe fields only, never raw response data. */
export function acceptanceHttpFailureArtifact(
  revision: string,
  phase: string,
  failure: ReturnType<typeof acceptanceHttpFailure>,
) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-z0-9-]{1,100}$/.test(phase))
    throw new Error('Invalid diagnostic context');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sanitized-acceptance-http-failure',
    revision,
    phase,
    ...acceptanceHttpFailure(failure.expectedStatus, failure.actualStatus, {
      error: { code: failure.errorCode },
    }),
    accepted: false,
  });
}
