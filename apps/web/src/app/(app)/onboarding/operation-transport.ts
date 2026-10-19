import {
  onboardingOperation,
  verifyOnboardingOperation,
  type OnboardingOperation,
  type OnboardingRequest,
} from '@axiom/types';
import type { OnboardingJournal } from './operation-journal';
export async function readBoundedOnboardingResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('The original response could not be verified.');
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) throw Error('The original response exceeded its limit.');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
export async function onboardingRequest(
  journal: OnboardingJournal,
  action: 'create' | 'read' | 'fence',
  request?: OnboardingRequest,
): Promise<OnboardingOperation> {
  const base = '/api/bff/v1/organizations';
  const path =
    action === 'create'
      ? `${base}/onboard`
      : `${base}/onboarding-operations/${journal.operationKey}${action === 'fence' ? '/fence' : `?requestSha256=${journal.requestSha256}`}`;
  const body =
    action === 'create'
      ? { operationKey: journal.operationKey, request }
      : action === 'fence'
        ? {
            operationKey: journal.operationKey,
            requestSha256: journal.requestSha256,
            ...(request
              ? {
                  originalCreateBody: JSON.stringify({
                    operationKey: journal.operationKey,
                    request,
                  }),
                }
              : {}),
          }
        : undefined;
  const response = await fetch(path, {
    method: action === 'read' ? 'GET' : 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': journal.actorId,
      'Idempotency-Key':
        action === 'fence' ? `${journal.operationKey}:fence` : journal.operationKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await readBoundedOnboardingResponse(response);
  if (!response.ok)
    throw Error(
      'The original outcome is unconfirmed. Check its saved outcome before preparing another organization.',
    );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('data' in value) ||
    !onboardingOperation.safeParse(value.data).success
  )
    throw Error('The original receipt could not be verified.');
  return verifyOnboardingOperation(value.data, journal);
}
