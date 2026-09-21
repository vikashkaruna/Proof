import { controls, LIBRARY_VERSION } from '@axiom/control-library';
import type { GapScanReport } from '@axiom/types';

/**
 * Score a 12-question gap-scan against the published control library.
 *
 * The 12 questions map to a curated subset of controls (one per
 * major control cluster). A "no" or "I don't know" answer produces
 * a finding for that control with score = 0 (worst).
 *
 * Posture score is the weighted average of the per-control scores
 * (weights from the control library).
 *
 * Exposure = sum of penalty points × (1 - score/100), capped at
 * the per-control statutory max.
 */
export async function computeGapScanReport(
  answers: Record<string, boolean | string | number | string[]>,
): Promise<GapScanReport> {
  const questionToControl: Record<string, string> = {
    q1: 'DPDPA-GOV-002',
    q2: 'DPDPA-CNS-001',
    q3: 'DPDPA-CNS-004',
    q4: 'DPDPA-DAT-003',
    q5: 'DPDPA-RCD-001',
    q6: 'DPDPA-SEC-001',
    q7: 'DPDPA-SEC-002',
    q8: 'DPDPA-BRCH-001',
    q9: 'DPDPA-RCD-002',
    q10: 'DPDPA-GOV-003',
    q11: 'DPDPA-XBR-001',
    q12: 'DPDPA-DPIA-001',
  };

  const findings: GapScanReport['findings'] = [];
  let totalWeight = 0;
  let weightedScore = 0;
  let totalExposure = 0;

  for (const [qid, controlId] of Object.entries(questionToControl)) {
    const control = controls.find((c) => c.id === controlId);
    if (!control) continue;

    const answer = answers[qid];
    const isYes = answer === true;
    const score = isYes ? 100 : 0;
    const riskPoints = ((100 - score) / 100) * control.scoring.penaltyPoints;

    findings.push({
      controlId: control.id,
      title: control.title,
      domain: control.domain,
      severity: control.severity,
      score,
      riskPoints,
      rationale: isYes
        ? `Self-attested compliant on ${control.id}.`
        : `Self-attested non-compliant on ${control.id} — see ${control.citations.map((c) => c.reference).join(', ')}.`,
    });

    totalWeight += control.scoring.weight;
    weightedScore += score * control.scoring.weight;
    totalExposure += Math.min(riskPoints, control.scoring.penaltyPoints);
  }

  // Apply a 5% global posture discount for unverified self-attestation
  const postureScore = Math.max(
    0,
    Math.min(100, (weightedScore / Math.max(0.0001, totalWeight)) * 0.95),
  );

  // Top recommendations: highest-risk findings first
  const top = [...findings]
    .filter((f) => f.score < 50)
    .sort((a, b) => b.riskPoints - a.riskPoints)
    .slice(0, 5);

  const recommendations = top.map((f, i) => ({
    priority: i + 1,
    title: `Address ${f.controlId} (${f.title})`,
    effort:
      f.severity === 'critical' ? '2–4 weeks' : f.severity === 'high' ? '2–3 weeks' : '1–2 weeks',
  }));

  return {
    postureScore: Math.round(postureScore * 100) / 100,
    estimatedExposureInr: Math.round(totalExposure * 10_00_000), // penalty points → INR estimate
    findings: findings.sort((a, b) => b.riskPoints - a.riskPoints),
    recommendations,
    // R-06: was a literal '0.1.0'. A gap-scan report stamped with a version
    // it was not scored against is a provenance claim that is simply false, and it
    // went stale the moment the library moved to 0.1.1.
    libraryVersion: LIBRARY_VERSION,
  };
}
