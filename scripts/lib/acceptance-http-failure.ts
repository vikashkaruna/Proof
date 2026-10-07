/** Private harness diagnostics only. Never retain a raw response or arbitrary error text. */
const codes = new Set([
  'validation_failed',
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
