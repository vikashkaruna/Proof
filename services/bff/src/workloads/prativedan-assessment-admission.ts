/** Unmounted read-only preflight. Point-in-time checks grant neither a claim nor
 * a tool capability; an atomic workload-bound claim and private channel remain required.
 */
import { z } from 'zod';
import { AgentName } from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { JwtSvidVerifier, workloadTrustDomain, type JwtTrustSource } from './jwt-svid.js';
import { WorkloadAuthenticator } from './registration.js';
import {
  prativedanAssessmentHumanContextSchema,
  type PrativedanAssessmentHumanContext,
} from '../services/prativedan-assessment-draft-store.js';
import { preparePrativedanAssessmentDraftSource } from '../services/prativedan-assessment-draft-source.js';

const uuid = z
  .uuid()
  .refine((v) => v === v.toLowerCase() && v !== '00000000-0000-0000-0000-000000000000');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.strictObject({
  tenantId: uuid,
  operationKey: uuid,
  runId: uuid,
  requestSha256: digest,
  sourceSha256: digest,
});
export type PrativedanAssessmentAdmissionSelection = z.infer<typeof selectionSchema>;
export interface PrativedanAssessmentAdmissionPorts {
  trust: JwtTrustSource;
  /** Required version-aware trusted snapshot. No privileged/default adapter. */
  registrations: { find(tenantId: string, spiffeId: string): Promise<unknown> };
  /** Server-owned session resolution, never a worker-supplied actor assertion. */
  resolveCurrentHuman(
    selection: PrativedanAssessmentAdmissionSelection,
  ): Promise<PrativedanAssessmentHumanContext>;
  /** Required authenticated-request verifier: current internal founder membership,
   * exact live session, enrolled MFA and unexpired session attestation. No defaults. */
  authorizeCurrentHuman(context: PrativedanAssessmentHumanContext): Promise<void>;
  isKilled(tenantId: string): Promise<boolean>;
  loadOriginalRequestedJournal(
    selection: PrativedanAssessmentAdmissionSelection,
    context: PrativedanAssessmentHumanContext,
  ): Promise<{ journal: unknown; reviewedRequestText: string }>;
}
export class PrativedanAssessmentAdmissionRefused extends Error {
  constructor() {
    super('Prativedan assessment preflight refused.');
    this.name = 'PrativedanAssessmentAdmissionRefused';
  }
}
export class PrativedanAssessmentAdmissionPreflight {
  private readonly domain: string;
  private readonly verifier: JwtSvidVerifier;
  constructor(
    configuration: unknown,
    private readonly ports: PrativedanAssessmentAdmissionPorts,
  ) {
    const config = z.strictObject({ trustDomain: workloadTrustDomain }).parse(configuration);
    this.domain = config.trustDomain;
    this.verifier = new JwtSvidVerifier(
      {
        audience: 'axiom-prativedan-assessment-tools',
        trustDomains: [this.domain],
        maxLifetimeSeconds: 300,
      },
      ports.trust,
    );
  }
  async check(token: string, rawSelection: unknown) {
    try {
      // Snapshot before awaits: caller mutation cannot change the selected durable operation.
      const selection = Object.freeze(selectionSchema.parse(rawSelection));
      const human = async () => {
        const context = prativedanAssessmentHumanContextSchema.parse(
          await this.ports.resolveCurrentHuman(selection),
        );
        if (context.tenantId !== selection.tenantId)
          throw new PrativedanAssessmentAdmissionRefused();
        await this.ports.authorizeCurrentHuman(context);
        if (await this.ports.isKilled(selection.tenantId))
          throw new PrativedanAssessmentAdmissionRefused();
        return context;
      };
      const authenticate = async () => {
        let registrationVersion: number | undefined;
        const authenticator = new WorkloadAuthenticator(this.verifier, {
          find: async (tenantId, spiffeId) => {
            if (spiffeId !== `spiffe://${this.domain}/agent/prativedan`)
              throw new PrativedanAssessmentAdmissionRefused();
            const snapshot = z
              .strictObject({
                id: uuid,
                tenant_id: uuid,
                agent_name: z.nativeEnum(AgentName),
                spiffe_id: z.string().max(2048),
                status: z.literal('active'),
                version: z.number().int().positive().max(2147483647),
              })
              .parse(await this.ports.registrations.find(tenantId, spiffeId));
            registrationVersion = snapshot.version;
            const { version: _version, ...row } = snapshot;
            return row;
          },
        });
        const identity = await authenticator.authenticate(
          token,
          selection.tenantId,
          AgentName.PRATIVEDAN,
          'report.write',
        );
        if (
          registrationVersion === undefined ||
          (await this.ports.trust.stillCurrent(identity.trustDomain, identity.bundleRevision)) !==
            true ||
          identity.expiresAt <= Date.now()
        )
          throw new PrativedanAssessmentAdmissionRefused();
        if (identity.spiffeId !== `spiffe://${this.domain}/agent/prativedan`)
          throw new PrativedanAssessmentAdmissionRefused();
        return Object.freeze({ ...identity, registrationVersion });
      };
      const firstIdentity = await authenticate();
      const firstHuman = await human();
      const load = async (context: PrativedanAssessmentHumanContext) => {
        const original = await this.ports.loadOriginalRequestedJournal(selection, context);
        const prepared = preparePrativedanAssessmentDraftSource(
          original.journal,
          original.reviewedRequestText,
        );
        const j = prepared.journal;
        if (
          j.state !== 'requested' ||
          j.tenant_id !== selection.tenantId ||
          j.actor_id !== context.actorId ||
          j.operation_key !== selection.operationKey ||
          j.run_id !== selection.runId ||
          j.request_sha256 !== selection.requestSha256 ||
          j.source_sha256 !== selection.sourceSha256
        )
          throw new PrativedanAssessmentAdmissionRefused();
        return prepared;
      };
      const first = await load(firstHuman);
      const secondHuman = await human();
      if (canonicalJson(firstHuman) !== canonicalJson(secondHuman))
        throw new PrativedanAssessmentAdmissionRefused();
      const second = await load(secondHuman);
      if (
        canonicalJson(first.journal) !== canonicalJson(second.journal) ||
        first.reviewedRequestText !== second.reviewedRequestText
      )
        throw new PrativedanAssessmentAdmissionRefused();
      const finalHuman = await human();
      if (canonicalJson(firstHuman) !== canonicalJson(finalHuman))
        throw new PrativedanAssessmentAdmissionRefused();
      // Fresh signature/bundle and live registration check follows all awaited source/human reads.
      const finalIdentity = await authenticate();
      if (
        canonicalJson(firstIdentity) !== canonicalJson(finalIdentity) ||
        finalIdentity.expiresAt <= Date.now()
      )
        throw new PrativedanAssessmentAdmissionRefused();
      const exposedHuman = await human();
      if (
        canonicalJson(firstHuman) !== canonicalJson(exposedHuman) ||
        finalIdentity.expiresAt <= Date.now()
      )
        throw new PrativedanAssessmentAdmissionRefused();
      const exposedIdentity = await authenticate();
      if (canonicalJson(firstIdentity) !== canonicalJson(exposedIdentity))
        throw new PrativedanAssessmentAdmissionRefused();
      return Object.freeze({
        preflight_only: true as const,
        claim_authorized: false as const,
        tool_authorized: false as const,
        publication_allowed: false as const,
        selection,
        identity: exposedIdentity,
      });
    } catch {
      throw new PrativedanAssessmentAdmissionRefused();
    }
  }
}
