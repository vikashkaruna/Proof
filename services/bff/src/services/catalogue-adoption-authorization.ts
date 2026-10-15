import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  mappingContextAdoptionBindingSchema,
  mappingContextAdoptionRequestSchema,
  type MappingContextAdoptionBinding,
} from '@axiom/control-library';
import type { MfaService } from './mfa.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

export const CATALOGUE_ADOPTION_STEP_UP_MS = 5 * 60_000;
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });
const authoritySchema = z.strictObject({
  session: z.strictObject({
    id: uuid,
    userId: uuid,
    expiresAt: instant,
    revokedAt: instant.nullable(),
  }),
  user: z.strictObject({ id: uuid, isAxiomInternal: z.boolean() }),
  membership: z.strictObject({ tenantId: uuid, userId: uuid, role: z.string() }),
  // The global row must exist. Missing/unknown stop state fails schema validation.
  globalStop: z.strictObject({ scope: z.literal('global'), engaged: z.boolean() }),
  tenantStops: z.array(z.strictObject({ tenantId: uuid, engaged: z.boolean() })),
});

/** Trusted server ports, never request-body facts. The session loader must verify the
 * current credential with the identity provider AND reload session/revocation, user,
 * membership and stop rows. A decoded JWT or cached browser role is insufficient.
 * The review loader retrieves the exact server-retained bytes shown for this named
 * operation. No publisher credential or mutation route is composed here.
 */
export interface CatalogueAdoptionAuthorityPorts {
  loadCurrentAuthority(binding: MappingContextAdoptionBinding): Promise<unknown>;
  loadReviewedRequestText(binding: MappingContextAdoptionBinding): Promise<string>;
  mfa: Pick<MfaService, 'issueChallenge' | 'consumeChallenge' | 'activeFactorId'>;
}
export class CatalogueAdoptionAuthorizationRefused extends Error {
  constructor() {
    super('Catalogue adoption authorization refused; fresh review and authentication required.');
  }
}
const sameBinding = (a: MappingContextAdoptionBinding, b: MappingContextAdoptionBinding) =>
  a.organisationId === b.organisationId &&
  a.actorId === b.actorId &&
  a.sessionId === b.sessionId &&
  a.correlationId === b.correlationId;

/** Server-derived digest includes actor/session/tenant plus every exact reviewed byte.
 * Reformatting the JSON after review requires a new challenge, even for equal values.
 */
function boundDigest(binding: MappingContextAdoptionBinding, reviewedRequestText: string) {
  return createHash('sha256')
    .update(JSON.stringify({ purpose: 'catalogue_adoption', ...binding, reviewedRequestText }))
    .digest('hex');
}

/** Deliberately unmounted. The returned closure is an in-process, bounded authority
 * handle, not a caller-supplied authorization flag and not a transferable bearer token.
 * It consumes MFA exactly once; callbacks revalidate without extending that grant.
 */
export function createCatalogueAdoptionAuthorizer(ports: CatalogueAdoptionAuthorityPorts) {
  async function readCurrent(binding: MappingContextAdoptionBinding) {
    const state = authoritySchema.parse(await ports.loadCurrentAuthority(binding));
    const expiresAt = Date.parse(state.session.expiresAt);
    if (
      state.session.id !== binding.sessionId ||
      state.session.userId !== binding.actorId ||
      state.session.revokedAt !== null ||
      expiresAt <= Date.now() ||
      state.user.id !== binding.actorId ||
      state.user.isAxiomInternal !== true ||
      state.membership.tenantId !== binding.organisationId ||
      state.membership.userId !== binding.actorId ||
      state.membership.role !== 'founder' ||
      state.globalStop.engaged ||
      state.tenantStops.some((s) => s.tenantId !== binding.organisationId || s.engaged)
    )
      throw new CatalogueAdoptionAuthorizationRefused();
    const factorId = uuid.parse(await ports.mfa.activeFactorId(binding.actorId));
    const reviewedRequestText = await ports.loadReviewedRequestText(binding);
    if (Buffer.byteLength(reviewedRequestText, 'utf8') > 4096)
      throw new CatalogueAdoptionAuthorizationRefused();
    const request = mappingContextAdoptionRequestSchema.parse(
      parsePrativedanAssessmentJson(reviewedRequestText),
    );
    if (Date.now() >= expiresAt) throw new CatalogueAdoptionAuthorizationRefused();
    return { expiresAt, reviewedRequestText, request, factorId };
  }
  return {
    async issue(suppliedBinding: MappingContextAdoptionBinding) {
      try {
        const binding = Object.freeze(mappingContextAdoptionBindingSchema.parse(suppliedBinding));
        const source = await readCurrent(binding);
        const issued = await ports.mfa.issueChallenge({
          userId: binding.actorId,
          tenantId: binding.organisationId,
          sessionId: binding.sessionId,
          purpose: 'catalogue_adoption',
          boundResourceRef: source.request.operationKey,
          boundPayloadSha256: boundDigest(binding, source.reviewedRequestText),
          ttlMs: Math.min(CATALOGUE_ADOPTION_STEP_UP_MS, source.expiresAt - Date.now()),
        });
        if (!issued.ok) throw new CatalogueAdoptionAuthorizationRefused();
        const current = await readCurrent(binding);
        if (
          current.reviewedRequestText !== source.reviewedRequestText ||
          current.factorId !== source.factorId
        )
          throw new CatalogueAdoptionAuthorizationRefused();
        return issued;
      } catch {
        throw new CatalogueAdoptionAuthorizationRefused();
      }
    },
    async consume(suppliedBinding: MappingContextAdoptionBinding, challengeId: string) {
      try {
        const binding = Object.freeze(mappingContextAdoptionBindingSchema.parse(suppliedBinding));
        const source = await readCurrent(binding);
        const consumed = await ports.mfa.consumeChallenge({
          challengeId: uuid.parse(challengeId),
          userId: binding.actorId,
          tenantId: binding.organisationId,
          purpose: 'catalogue_adoption',
          boundResourceRef: source.request.operationKey,
          boundPayloadSha256: boundDigest(binding, source.reviewedRequestText),
          consumedFor: `catalogue_adoption:${binding.organisationId}:${source.request.operationKey}`,
        });
        if (!consumed.ok) throw new CatalogueAdoptionAuthorizationRefused();
        const challengedFactorId = uuid.parse(consumed.factorId);
        if (challengedFactorId !== source.factorId)
          throw new CatalogueAdoptionAuthorizationRefused();
        const satisfiedAt = instant.parse(consumed.satisfiedAt);
        const satisfiedMs = Date.parse(satisfiedAt);
        const expiresAt = Math.min(
          source.expiresAt,
          Date.parse(instant.parse(consumed.expiresAt)),
          satisfiedMs + CATALOGUE_ADOPTION_STEP_UP_MS,
        );
        if (satisfiedMs > Date.now() || Date.now() >= expiresAt)
          throw new CatalogueAdoptionAuthorizationRefused();
        let active = true;
        const authorizeCurrentHuman = async (supplied: MappingContextAdoptionBinding) => {
          try {
            if (
              !active ||
              Date.now() >= expiresAt ||
              !sameBinding(mappingContextAdoptionBindingSchema.parse(supplied), binding)
            )
              throw new CatalogueAdoptionAuthorizationRefused();
            const current = await readCurrent(binding);
            if (
              !active ||
              Date.now() >= expiresAt ||
              current.reviewedRequestText !== source.reviewedRequestText ||
              current.factorId !== challengedFactorId
            )
              throw new CatalogueAdoptionAuthorizationRefused();
            return { binding: { ...binding }, reviewedRequestText: source.reviewedRequestText };
          } catch {
            active = false;
            throw new CatalogueAdoptionAuthorizationRefused();
          }
        };
        await authorizeCurrentHuman(binding);
        return Object.freeze({
          binding,
          request: Object.freeze(source.request),
          expiresAt: new Date(expiresAt).toISOString(),
          authorizeCurrentHuman,
        });
      } catch {
        throw new CatalogueAdoptionAuthorizationRefused();
      }
    },
  };
}
