import { createHash } from 'node:crypto';

/**
 * W1 · R-08 — what the approver actually agreed to, per action.
 *
 * `planVersion` closed the case where a plan was *revised* between the
 * challenge and the approval. It cannot close the case where the plan's
 * version never moves and an action's content does, and that is the more
 * available attack: `trg_actions_approved_immutable` only locks
 * `action_type` / `parameters` / `rollback_definition` / `closes_finding_ids`
 * once `approval_status` is already `approved`, `executing` or `succeeded`.
 * While an action sits in `awaiting_approval` — exactly the window in which
 * the approver is reading it and raising a step-up — every one of those fields
 * is writable by any owner, admin, reviewer, approver or agent in the tenant.
 *
 * So the sequence the step-up was supposed to prevent still worked:
 *
 *   1. the approver reads parameters X and raises a challenge
 *   2. someone rewrites the action to Y; status is still `awaiting_approval`,
 *      so the immutability trigger does not fire and the plan version does
 *      not move
 *   3. the approver submits their code; planId, actionIds, mode and
 *      planVersion are all unchanged, so the binding still matches
 *   4. Y is approved, and *now* becomes immutable — frozen, and executed
 *
 * Hashing the content into the binding makes step 3 fail. The digest is
 * computed from the database rows at both ends, never from anything the
 * client sends: a caller that could name its own digest could name the one
 * belonging to the content it has already replaced.
 */

/** The columns that constitute the act. Selected identically at both ends. */
export const ACTION_CONTENT_COLUMNS =
  'id, action_type, parameters, rollback_definition, closes_finding_ids, dry_run_result';

export interface ApprovableActionContent {
  id: string;
  action_type?: string | null;
  parameters?: unknown;
  rollback_definition?: unknown;
  closes_finding_ids?: readonly string[] | null;
  dry_run_result?: unknown;
}

/**
 * Deterministic serialisation. Object keys are sorted recursively; array order
 * is preserved.
 *
 * Preserving array order is deliberate. A parameters array is frequently
 * ordered — columns to mask in sequence, rules applied in precedence — so
 * sorting one would let a reordering that changes behaviour hash identically.
 * `closes_finding_ids` is the exception, and it is sorted explicitly at the
 * field level below, because that one genuinely is a set.
 *
 * `undefined` is normalised to null rather than dropped: `JSON.stringify`
 * omits undefined-valued keys, so without this an absent field and an
 * explicitly-null field would produce different digests for the same act.
 */
export function canonicalise(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/**
 * The content hash of a single action.
 *
 * Risk fields (`risk_class`, `risk_score`, `blast_radius`) are deliberately
 * NOT included. They describe the action rather than define it, and they are
 * derived from the parameters that are pinned here — so a change to any of
 * them that matters is already a change to something in this digest, while a
 * background re-scoring that leaves the action identical would otherwise
 * invalidate an approval in flight for a reason the approver's decision does
 * not depend on.
 */
export function actionContentSha256(action: ApprovableActionContent): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        actionType: action.action_type ?? null,
        parameters: action.parameters ?? null,
        rollbackDefinition: action.rollback_definition ?? null,
        // A set, so ordering carries no meaning and must not change the hash.
        closesFindingIds: [...(action.closes_finding_ids ?? [])].sort(),
        // The dry-run diff the approver read before agreeing. A re-run that
        // produces a different simulated outcome is a different thing to have
        // agreed to, even when the action definition is untouched.
        dryRunResult: action.dry_run_result ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * One digest over the whole action set, ordered by id so that the same set
 * presented in a different order binds identically — the same reason
 * `approvalBindingSha256` sorts the ids themselves.
 */
export function actionSetDigestSha256(actions: readonly ApprovableActionContent[]): string {
  const perAction = actions
    .map((action) => ({ id: action.id, content: actionContentSha256(action) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(canonicalJson(perAction), 'utf8').digest('hex');
}
