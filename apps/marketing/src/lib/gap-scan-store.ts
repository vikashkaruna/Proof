import { createSupabaseAdmin } from '@axiom/supabase';
import type { GapScanReport } from '@axiom/types';

export interface GapScanRecord {
  id: string;
  session_id: string;
  sector?: string;
  employee_band?: string;
  processes_children_data?: boolean;
  is_sdf?: boolean;
  answers: Record<string, unknown>;
  report_snapshot: GapScanReport;
  library_version: string;
  posture_score: number;
  estimated_exposure_inr: number;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_company?: string;
  follow_up_requested?: boolean;
  marketing_consent?: boolean;
  created_at: string;
}

// Global in-memory cache preserved across Node.js runtime invocations
const globalStore = globalThis as unknown as {
  __gapScanCache?: Map<string, GapScanRecord>;
};

if (!globalStore.__gapScanCache) {
  globalStore.__gapScanCache = new Map<string, GapScanRecord>();
}

const memoryCache = globalStore.__gapScanCache;

/**
 * Deterministic sample report used for preview and static export.
 */
export const SAMPLE_GAP_SCAN_RECORD: GapScanRecord = {
  id: 'sample',
  session_id: 'sample-session',
  sector: 'BFSI',
  employee_band: '201-500',
  processes_children_data: false,
  is_sdf: true,
  answers: {},
  report_snapshot: {
    postureScore: 68,
    estimatedExposureInr: 150000000,
    libraryVersion: '0.1.0',
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
  library_version: '0.1.0',
  posture_score: 68,
  estimated_exposure_inr: 150000000,
  created_at: new Date().toISOString(),
};

/**
 * Persists a gap scan submission. Tries Supabase first, falls back smoothly to in-memory store.
 * Never throws an unhandled error so visitors always receive their report.
 */
export async function saveGapScanSubmission(record: GapScanRecord): Promise<string> {
  // Always cache locally
  memoryCache.set(record.id, record);

  // Prune cache if it grows beyond 1,000 entries
  if (memoryCache.size > 1000) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }

  // Attempt database persistence
  try {
    const supabase = createSupabaseAdmin();
    const insertPayload: Record<string, unknown> = {
      id: record.id,
      session_id: record.session_id,
      sector: record.sector,
      employee_band: record.employee_band,
      processes_children_data: record.processes_children_data,
      is_sdf: record.is_sdf,
      answers: {
        ...record.answers,
        ...(record.contact_phone ? { _contact_phone: record.contact_phone } : {}),
      },
      report_snapshot: record.report_snapshot,
      library_version: record.library_version,
      posture_score: record.posture_score,
      estimated_exposure_inr: record.estimated_exposure_inr,
      contact_name: record.contact_name,
      contact_email: record.contact_email,
      contact_company: record.contact_company,
      follow_up_requested: record.follow_up_requested,
      marketing_consent: record.marketing_consent,
    };
    if (record.contact_phone) {
      insertPayload.contact_phone = record.contact_phone;
    }

    let { data, error } = await supabase
      .from('gap_scan_responses')
      .insert(insertPayload)
      .select('id')
      .single();

    // If database does not yet have contact_phone column, retry without it
    if (error && error.message.includes('contact_phone')) {
      delete insertPayload.contact_phone;
      const retry = await supabase
        .from('gap_scan_responses')
        .insert(insertPayload)
        .select('id')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      console.warn(
        '[gap-scan-store] Database persistence notice (resilient fallback active):',
        error.message,
      );
    } else if (data?.id) {
      return data.id;
    }
  } catch (err) {
    console.warn(
      '[gap-scan-store] Database unavailable, using in-memory store:',
      err instanceof Error ? err.message : err,
    );
  }

  return record.id;
}

/**
 * Retrieves a gap-scan report by ID, enforcing ownership.
 *
 * A gap-scan record holds a prospect's company, name, email, phone, posture
 * score and rupee exposure estimate. It is personal data, and on a DPDPA
 * product it is the last place that should leak.
 *
 * The previous signature took an `isLocal` flag and applied the ownership
 * filter only `if (accessHash && !isLocal)`. Two defects followed from that
 * single line:
 *
 *   1. The `!isLocal` half was environment-conditional — the caller set it
 *      true in staging, preprod and any container without NODE_ENV, so the
 *      ownership check was off in three deployed environments (the SEC-1
 *      family, extended to the marketing site).
 *   2. The `accessHash &&` half meant the filter was ALSO skipped whenever the
 *      caller presented no cookie at all — in every environment, production
 *      included. `.single()` then matched on `id` alone. A caller who
 *      presented nothing received the record; only a caller who already held a
 *      valid cookie was checked. That is an unconditional IDOR.
 *
 * Ownership is now required unconditionally. `accessHash` is not optional.
 */
export async function getGapScanReport(
  id: string,
  accessHash: string | undefined,
): Promise<GapScanRecord | null> {
  if (id === 'sample') {
    return SAMPLE_GAP_SCAN_RECORD;
  }

  // No session cookie means no claim of ownership, which means no record.
  if (!accessHash) return null;

  const record = await readGapScanRecord(id);
  if (!record) return null;
  return record.session_id === accessHash ? record : null;
}

/**
 * Retrieves a gap-scan report WITHOUT an ownership check.
 *
 * Restricted to trusted server-side callers that have established the
 * requester's right to the record by another means — currently only the
 * email-dispatch route, which delivers the report to the address captured on
 * the record itself rather than to an address the caller supplies.
 *
 * Never call this from a page or from any handler whose result is returned to
 * the requester.
 */
export async function getGapScanReportForTrustedDispatch(
  id: string,
): Promise<GapScanRecord | null> {
  if (id === 'sample') return SAMPLE_GAP_SCAN_RECORD;
  return readGapScanRecord(id);
}

/** Storage lookup with no authorisation semantics of its own. */
async function readGapScanRecord(id: string): Promise<GapScanRecord | null> {
  try {
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase
      .from('gap_scan_responses')
      .select('*')
      .eq('id', id)
      .single();
    if (data && !error && (data as GapScanRecord).report_snapshot) {
      return data as GapScanRecord;
    }
  } catch (err) {
    console.warn(
      '[gap-scan-store] Supabase fetch notice:',
      err instanceof Error ? err.message : err,
    );
  }

  return memoryCache.get(id) ?? null;
}
