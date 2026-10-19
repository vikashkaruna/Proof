/** Read-only provenance from existing approved onboarding records. This does
 * not establish current configuration, live connectivity or data transfers. */
import { z } from 'zod';
const uuid = z.uuid();
// Retain PostgreSQL fractional precision; adjacent microseconds must not
// collapse into the same apparent review receipt through Date.parse().
function exactInstant(value: string): bigint | null {
  const p = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!p) return null;
  const seconds = Date.parse(`${p[1]}${p[3]}`);
  return Number.isFinite(seconds)
    ? BigInt(seconds) * 1_000_000n + BigInt((p[2] ?? '').padEnd(9, '0'))
    : null;
}
const instant = z.iso.datetime({ offset: true }).refine((v) => exactInstant(v) !== null);
const receipt = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,18}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const link = z
  .object({
    tenant_id: uuid,
    proposal_id: uuid,
    source_index: z.number().int().min(0).max(99),
    system_id: uuid,
  })
  .strict();
export const approvedGraphProposals = z
  .array(
    z
      .object({
        id: uuid,
        tenant_id: uuid,
        estate_id: uuid,
        content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        status: z.literal('approved'),
        reviewed_at: instant,
        onboarding_proposal_systems: z.array(link).min(1).max(100),
      })
      .strict(),
  )
  .max(1);
const approvalReceipts = z
  .array(
    z
      .object({
        id: receipt,
        tenant_id: uuid,
        target_ref: uuid,
        actor_type: z.literal('human'),
        action_type: z.literal('onboarding.proposal.approved'),
        result: z.literal('success'),
        occurred_at: instant,
        commitment: z.string().regex(/^[a-f0-9]{64}$/),
        system_ids: z.array(uuid).min(1).max(100),
      })
      .strict(),
  )
  .max(2);
export type SystemDerivation =
  | {
      state: 'recorded';
      proposalId: string;
      sourceIndex: number;
      contentSha256: string;
      reviewReceiptId: string;
      reviewedAt: string;
      sourceHref: string | null;
    }
  | { state: 'absent' | 'unavailable' };
export interface GraphProvenance {
  bySystem: Record<string, SystemDerivation>;
  state: 'available' | 'unavailable';
}
export function unavailableProvenance(systems: { id: string }[]): GraphProvenance {
  return {
    state: 'unavailable',
    bySystem: Object.fromEntries(systems.map((s) => [s.id, { state: 'unavailable' }])),
  };
}
export function projectApprovedDerivation(
  tenantId: string,
  systems: { id: string; estateId: string }[],
  rawProposals: unknown,
  rawReceipts: unknown,
  canOpenSource: boolean,
): GraphProvenance {
  try {
    const proposals = approvedGraphProposals.parse(rawProposals),
      receipts = approvalReceipts.parse(rawReceipts);
    if (
      proposals.some((p) => p.tenant_id !== tenantId) ||
      receipts.some((r) => r.tenant_id !== tenantId)
    )
      throw new Error('Foreign source refused');
    const bySystem: Record<string, SystemDerivation> = Object.fromEntries(
      systems.map((s) => [s.id, { state: 'absent' }]),
    );
    const current = new Map(systems.map((s) => [s.id, s]));
    for (const p of proposals) {
      const links = p.onboarding_proposal_systems;
      if (
        links.some((l) => l.tenant_id !== tenantId || l.proposal_id !== p.id) ||
        new Set(links.map((l) => l.system_id)).size !== links.length ||
        links
          .map((l) => l.source_index)
          .sort((a, b) => a - b)
          .some((v, i) => v !== i)
      )
        throw new Error('Incomplete source mapping refused');
      const matches = receipts.filter(
        (r) =>
          r.target_ref === p.id &&
          r.commitment === p.content_sha256 &&
          exactInstant(r.occurred_at) === exactInstant(p.reviewed_at) &&
          new Set(r.system_ids).size === links.length &&
          r.system_ids.length === links.length &&
          links.every((l) => r.system_ids.includes(l.system_id)),
      );
      for (const l of links) {
        const s = current.get(l.system_id);
        if (!s) continue;
        if (matches.length !== 1 || s.estateId !== p.estate_id) {
          bySystem[s.id] = { state: 'unavailable' };
          continue;
        }
        bySystem[s.id] = {
          state: 'recorded',
          proposalId: p.id,
          sourceIndex: l.source_index,
          contentSha256: p.content_sha256,
          reviewReceiptId: matches[0]!.id,
          reviewedAt: p.reviewed_at,
          sourceHref: canOpenSource ? `/estate/onboarding#proposal-${p.id}` : null,
        };
      }
    }
    return { state: 'available', bySystem };
  } catch {
    return unavailableProvenance(systems);
  }
}
export type CategoryOrigin = 'declared' | 'observed' | 'unknown';
export const categoryOriginLabel = (origin: CategoryOrigin) =>
  origin === 'declared'
    ? 'Declared category'
    : origin === 'observed'
      ? 'Recorded as observed (scan evidence not linked)'
      : 'Category source unknown';
