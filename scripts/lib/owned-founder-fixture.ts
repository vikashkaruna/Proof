/** Global founder designations for newly created synthetic, disposable accounts only. */
import { z } from 'zod';
import { loadParityFixture } from './parity-fixture-target-core.js';

export function assertLocalFounderFixtureTarget(topology: string | undefined) {
  if (topology !== undefined && topology !== 'local-docker')
    throw new Error('Global founder fixture requires owned local parity');
}

export function wantsGlobalFounder(options: {
  role?: string;
  isInternal?: boolean;
  globalFounder?: boolean;
}) {
  if (options.globalFounder === true && (options.role !== 'founder' || options.isInternal !== true))
    throw new Error('Global fixture founder must be an internal founder');
  return (
    options.role === 'founder' && options.isInternal === true && options.globalFounder !== false
  );
}

export async function designateOwnedFixtureFounder(input: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
  email: string;
  designate: (request: {
    p_user_id: string;
    p_designated_by: string;
    p_reason: string;
  }) => Promise<void>;
}) {
  const userId = z.uuid().parse(input.userId);
  // All callers pass the result of a NEW Auth admin creation, never operator accounts.
  if (
    !/^(?:journey-[a-z0-9-]+|public-report-[a-f0-9-]+|persona-founder-[a-f0-9]{8})@example\.invalid$/.test(
      input.email,
    )
  )
    throw new Error('Synthetic founder account required');
  const fixture = loadParityFixture(input.root, input.environment);
  if (
    fixture.apiOrigin !== new URL(input.supabaseUrl).origin ||
    fixture.status.SERVICE_ROLE_KEY !== input.serviceKey
  )
    throw new Error('Founder fixture target differs from owned parity');
  await input.designate({
    p_user_id: userId,
    p_designated_by: 'owned synthetic acceptance fixture',
    p_reason: 'Fresh fictional internal founder for disposable acceptance journeys',
  });
}
