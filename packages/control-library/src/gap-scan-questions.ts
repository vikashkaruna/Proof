/**
 * The public gap-scan question set — the single source for both the form and
 * BFF scoring, so a prompt and the control it scores can never drift apart.
 *
 * Every prompt is phrased so that "yes" means the mapped control's objective
 * is met; an organisation to which a control does not apply (for example, one
 * that makes no cross-border transfers) can truthfully answer "yes".
 *
 * Bump GAP_SCAN_QUESTION_SET_VERSION on any wording or mapping change. Stored
 * reports keep the version they were scored with and are never rescored.
 */
export const GAP_SCAN_QUESTION_SET_VERSION = '2026-09-24';

export interface GapScanQuestion {
  id: string;
  prompt: string;
  controlId: string;
}

export const GAP_SCAN_QUESTIONS: readonly GapScanQuestion[] = [
  {
    id: 'q1',
    prompt: 'Do you have a publicly accessible privacy policy on your website?',
    controlId: 'DPDPA-GOV-002',
  },
  {
    id: 'q2',
    prompt:
      'Is the consent capture on your site/app a clear affirmative action (not pre-ticked, not implied)?',
    controlId: 'DPDPA-CNS-001',
  },
  {
    id: 'q3',
    prompt: 'Can a user withdraw consent as easily as they gave it?',
    controlId: 'DPDPA-CNS-004',
  },
  {
    id: 'q4',
    prompt: 'Do you have a named grievance officer / privacy contact published?',
    controlId: 'DPDPA-DAT-003',
  },
  {
    id: 'q5',
    prompt:
      'Do you maintain a written Record of Processing Activities (RoPA) — purpose, data items, lawful basis, retention, processors?',
    controlId: 'DPDPA-RCD-001',
  },
  {
    id: 'q6',
    prompt: 'Is personal data encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+)?',
    controlId: 'DPDPA-SEC-001',
  },
  {
    // C-W0-7: previously asked about MFA while scoring least-privilege access.
    id: 'q7',
    prompt:
      'Is access to personal data limited to the staff and systems that need it (least privilege), with access reviewed periodically?',
    controlId: 'DPDPA-SEC-002',
  },
  {
    id: 'q8',
    prompt: 'Do you have a documented breach response procedure with the 72-hour DPB clock?',
    controlId: 'DPDPA-BRCH-001',
  },
  {
    id: 'q9',
    prompt: 'Have you inventoried all systems that hold personal data?',
    controlId: 'DPDPA-RCD-002',
  },
  {
    id: 'q10',
    prompt:
      'Do you have signed Data Processing Agreements (DPAs) with every third party that processes personal data on your behalf?',
    controlId: 'DPDPA-GOV-003',
  },
  {
    // C-W0-7: previously "Do you transfer any personal data outside India?",
    // where admitting a transfer scored as full compliance.
    id: 'q11',
    prompt:
      'Is every transfer of personal data outside India (if you make any) mapped and limited to countries not restricted by the Government?',
    controlId: 'DPDPA-XBR-001',
  },
  {
    // C-W0-7: previously asked about any DPIA in the past 12 months; the
    // control requires one before new high-risk processing launches.
    id: 'q12',
    prompt:
      'Do you complete a Data Protection Impact Assessment (DPIA) before launching any new high-risk processing of personal data?',
    controlId: 'DPDPA-DPIA-001',
  },
];
