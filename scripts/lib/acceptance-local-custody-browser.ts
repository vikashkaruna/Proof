import { loadParityFixture } from './parity-fixture-target-core';

type PersonaBinding = Readonly<{
  supabaseUrl: string;
  serviceKey: string;
  publishableKey: string;
  anonKey: string;
}>;
/** Engineering fixture authority only. No hostname/flag can authorize setup writes.
 * The real loader validates canonical state paths, owned DB/Kong labels and ports.
 * Repeated checks pin the first full DB ID as well as selected project and keys. */
export function custodyBrowserFixtureGuard(
  root: string,
  persona: PersonaBinding,
  load: typeof loadParityFixture = loadParityFixture,
) {
  let pinned: string | undefined;
  return () => {
    const fixture = load(root);
    const status = fixture.status;
    if (
      !persona.serviceKey ||
      !persona.publishableKey ||
      !persona.anonKey ||
      persona.supabaseUrl !== status.API_URL ||
      new URL(persona.supabaseUrl).origin !== fixture.apiOrigin ||
      persona.serviceKey !== status.SERVICE_ROLE_KEY ||
      persona.publishableKey !== status.PUBLISHABLE_KEY ||
      persona.anonKey !== status.ANON_KEY
    )
      throw new Error('Custody browser persona fixture binding refused');
    const identity = JSON.stringify([
      fixture.root,
      fixture.stateDirectory,
      fixture.projectId,
      fixture.databaseId,
      fixture.apiOrigin,
      status.API_URL,
      status.SERVICE_ROLE_KEY,
      status.PUBLISHABLE_KEY,
      status.ANON_KEY,
    ]);
    if (pinned !== undefined && pinned !== identity)
      throw new Error('Custody browser fixture replacement refused');
    pinned = identity;
  };
}
