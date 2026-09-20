import { describe, it, expect } from 'vitest';
import {
  actionContentSha256,
  actionSetDigestSha256,
  canonicalJson,
  type ApprovableActionContent,
} from './action-digest.js';

/**
 * W1 · R-08 — the properties the content digest has to have.
 *
 * Two failure modes matter and they pull in opposite directions. Hash too
 * loosely and an action can be rewritten under a satisfied challenge. Hash too
 * strictly — on key order, on a set's ordering, on a field the approver never
 * saw — and honest approvals are refused at random, which ends with someone
 * turning the check off.
 */

const base = (over: Partial<ApprovableActionContent> = {}): ApprovableActionContent => ({
  id: '33333333-3333-4333-8333-33333333000a',
  action_type: 'data.mask',
  parameters: { columns: ['email'], scope: 'tenant' },
  rollback_definition: { restoreFrom: 'snapshot-1' },
  closes_finding_ids: ['44444444-4444-4444-8444-444444444001'],
  dry_run_result: { recordsAffected: 12 },
  ...over,
});

describe('canonicalJson', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('preserves array order, which carries meaning in parameters', () => {
    // Masking [email, phone] and masking [phone, email] may be the same act,
    // but a precedence-ordered rule list is not, and this layer cannot tell
    // them apart. It must therefore treat order as significant.
    expect(canonicalJson({ rules: ['a', 'b'] })).not.toBe(canonicalJson({ rules: ['b', 'a'] }));
  });

  it('treats an absent field and an explicitly null one as the same', () => {
    // JSON.stringify drops undefined-valued keys, so without normalisation
    // these two would digest differently while describing the same action.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1, b: null }));
  });

  it('canonicalises inside arrays too', () => {
    expect(canonicalJson([{ x: 1, y: 2 }])).toBe(canonicalJson([{ y: 2, x: 1 }]));
  });
});

describe('actionContentSha256', () => {
  it('is stable across key reordering of the same content', () => {
    const a = base({ parameters: { columns: ['email'], scope: 'tenant' } });
    const b = base({ parameters: { scope: 'tenant', columns: ['email'] } });
    expect(actionContentSha256(a)).toBe(actionContentSha256(b));
  });

  it.each([
    ['action_type', { action_type: 'data.delete' }],
    ['parameters', { parameters: { columns: ['email', 'aadhaar'], scope: 'tenant' } }],
    ['rollback_definition', { rollback_definition: {} }],
    ['dry_run_result', { dry_run_result: { recordsAffected: 4_000_000 } }],
    ['closes_finding_ids', { closes_finding_ids: ['44444444-4444-4444-8444-444444444009'] }],
  ])('changes when %s changes', (_label, over) => {
    expect(actionContentSha256(base(over))).not.toBe(actionContentSha256(base()));
  });

  it('treats closes_finding_ids as a set', () => {
    const f1 = '44444444-4444-4444-8444-444444444001';
    const f2 = '44444444-4444-4444-8444-444444444002';
    expect(actionContentSha256(base({ closes_finding_ids: [f1, f2] }))).toBe(
      actionContentSha256(base({ closes_finding_ids: [f2, f1] })),
    );
  });

  it('is unmoved by fields the digest deliberately excludes', () => {
    // Risk scoring describes the action rather than defining it, and is
    // derived from the parameters already pinned above. A background
    // re-scoring must not invalidate an approval in flight.
    const withRisk = { ...base(), risk_score: 91, blast_radius: { systems: 12 } };
    expect(actionContentSha256(withRisk as ApprovableActionContent)).toBe(
      actionContentSha256(base()),
    );
  });
});

describe('actionSetDigestSha256', () => {
  const A = base({ id: '33333333-3333-4333-8333-33333333000a' });
  const B = base({
    id: '33333333-3333-4333-8333-33333333000b',
    parameters: { columns: ['phone'] },
  });

  it('does not depend on the order the rows came back in', () => {
    // PostgREST does not promise an order, so a digest that depended on one
    // would refuse valid approvals intermittently — the worst kind of gate.
    expect(actionSetDigestSha256([A, B])).toBe(actionSetDigestSha256([B, A]));
  });

  it('changes when any member changes', () => {
    const edited = { ...B, parameters: { columns: ['phone', 'email'] } };
    expect(actionSetDigestSha256([A, edited])).not.toBe(actionSetDigestSha256([A, B]));
  });

  it('distinguishes a smaller set from a larger one', () => {
    expect(actionSetDigestSha256([A])).not.toBe(actionSetDigestSha256([A, B]));
  });

  it('binds the id to its content, so swapping two actions’ content is caught', () => {
    const swapped = [
      { ...A, parameters: B.parameters },
      { ...B, parameters: A.parameters },
    ];
    expect(actionSetDigestSha256(swapped)).not.toBe(actionSetDigestSha256([A, B]));
  });
});
