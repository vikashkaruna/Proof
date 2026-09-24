import { LIBRARY_VERSION } from '@axiom/control-library';
import { GapScanStoredReportSchema, type GapScanStoredReport } from '@axiom/types';
import { gapScanBackend } from './gap-scan-backend';

export const SAMPLE_GAP_SCAN_RECORD: GapScanStoredReport = {
  id: 'sample',
  report_snapshot: {
    postureScore: 68,
    estimatedExposureInr: 150000000,
    libraryVersion: LIBRARY_VERSION,
    findings: [
      {
        controlId: 'DPDPA-SEC-001',
        title: 'Encryption of Personal Data at Rest and in Transit',
        domain: 'Data Security',
        severity: 'critical',
        score: 0,
        riskPoints: 25,
        rationale:
          'Unencrypted storage of financial identifiers creates severe statutory breach exposure.',
      },
      {
        controlId: 'DPDPA-BRCH-001',
        title: '72-Hour Data Protection Board Breach Notification',
        domain: 'Breach Response',
        severity: 'high',
        score: 30,
        riskPoints: 20,
        rationale:
          'Missing automated incident response workflows to notify DPB within the mandatory 72-hour window.',
      },
      {
        controlId: 'DPDPA-CNS-001',
        title: 'Itemised Notice and Consent Management',
        domain: 'Consent Governance',
        severity: 'medium',
        score: 50,
        riskPoints: 15,
        rationale:
          'Consent records lack granular multi-language purpose specifications mandated under Section 6.',
      },
    ],
    recommendations: [
      {
        priority: 1,
        title: 'Establish 72-hour statutory breach response procedure',
        effort: '2 weeks',
      },
      {
        priority: 2,
        title: 'Deploy KMS-backed encryption across primary databases',
        effort: '3 weeks',
      },
      {
        priority: 3,
        title: 'Implement itemised consent capture with withdrawal logging',
        effort: '4 weeks',
      },
    ],
  },
  library_version: LIBRARY_VERSION,
  posture_score: 68,
  estimated_exposure_inr: 150000000,
  created_at: new Date().toISOString(),
};

export async function getGapScanReport(
  id: string,
  access: string | undefined,
): Promise<GapScanStoredReport | null> {
  if (!access || !/^[a-f0-9]{64}$/.test(access) || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const res = await gapScanBackend(`/public/gap-scan/${encodeURIComponent(id)}`, {
    headers: { 'X-Gap-Scan-Access': access },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Report service is unavailable. Please try again.');
  return GapScanStoredReportSchema.parse(await res.json());
}
