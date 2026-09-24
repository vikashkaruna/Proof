import { describe, expect, it } from 'vitest';
import { controls } from './controls';
import { GAP_SCAN_QUESTIONS, GAP_SCAN_QUESTION_SET_VERSION } from './gap-scan-questions';

describe('public gap-scan question set (C-W0-7)', () => {
  it('has twelve unique questions, each mapped to a distinct published control', () => {
    expect(GAP_SCAN_QUESTIONS).toHaveLength(12);
    expect(new Set(GAP_SCAN_QUESTIONS.map((q) => q.id)).size).toBe(12);
    expect(new Set(GAP_SCAN_QUESTIONS.map((q) => q.controlId)).size).toBe(12);
    for (const q of GAP_SCAN_QUESTIONS)
      expect(
        controls.some((c) => c.id === q.controlId),
        `${q.id} -> ${q.controlId}`,
      ).toBe(true);
    expect(GAP_SCAN_QUESTION_SET_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('asks what each mapped control requires', () => {
    const byId = Object.fromEntries(GAP_SCAN_QUESTIONS.map((q) => [q.id, q]));
    // q7 scores least-privilege access; it must not ask about MFA.
    expect(byId.q7!.controlId).toBe('DPDPA-SEC-002');
    expect(byId.q7!.prompt).toMatch(/least privilege/i);
    expect(byId.q7!.prompt).not.toMatch(/multi-factor|MFA/i);
    // q11: "yes" must mean compliant, never "yes, we transfer".
    expect(byId.q11!.controlId).toBe('DPDPA-XBR-001');
    expect(byId.q11!.prompt).not.toBe('Do you transfer any personal data outside India?');
    expect(byId.q11!.prompt).toMatch(/restricted/i);
    // q12 asks about DPIA timing relative to new high-risk processing.
    expect(byId.q12!.controlId).toBe('DPDPA-DPIA-001');
    expect(byId.q12!.prompt).toMatch(/before launching/i);
    expect(byId.q12!.prompt).not.toMatch(/past 12 months/i);
  });
});
