import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const retainedArtifactSchema = z.object({
  reportStatus: z.string(),
  status: z.enum(['not_started', 'pending', 'settled']),
  operationKey: z.uuid().nullable(),
  lastErrorCode: z.string().nullable(),
  pdf: z
    .object({ sha256: digest, byteSize: z.number().int().positive(), retainUntil: z.string() })
    .nullable(),
});

/**
 * The build route answers a settled build with only the identifiers it just
 * recorded (`reportId`, `buildId`, `status`, `operationKey`); the full artifact
 * detail (report status, PDF receipt) comes from the list read. A pending
 * answer carries the detail. Both must parse, or a settled build leaves the
 * card unchanged and skips the refresh that would show it.
 */
export const retainedBuildResultSchema = z.object({
  reportId: z.uuid(),
  status: z.enum(['pending', 'settled']),
  operationKey: z.uuid().nullable(),
  reportStatus: z.string().optional(),
  lastErrorCode: z.string().nullable().optional(),
  pdf: retainedArtifactSchema.shape.pdf.optional(),
});

type RetainedArtifact = z.infer<typeof retainedArtifactSchema>;
type RetainedBuildResult = z.infer<typeof retainedBuildResultSchema>;
type RequestWithArtifact = {
  reportId: string | null;
  reportStatus: string | null;
  artifact: RetainedArtifact | null;
};

const rank = { not_started: 0, pending: 1, settled: 2 } as const;

/** A settled provider response cannot be rolled back by an older list read. */
export function mergeRetainedRequests<T extends RequestWithArtifact>(
  current: T[],
  incoming: T[],
): T[] {
  const byReport = new Map(
    current.filter((item) => item.reportId).map((item) => [item.reportId, item]),
  );
  return incoming.map((item) => {
    const prior = byReport.get(item.reportId);
    if (
      !prior?.artifact ||
      !item.artifact ||
      rank[prior.artifact.status] <= rank[item.artifact.status]
    )
      return item;
    return {
      ...item,
      artifact: {
        ...prior.artifact,
        reportStatus: item.reportStatus ?? prior.artifact.reportStatus,
      },
    };
  });
}

/**
 * Project the authoritative build response immediately, before any list
 * refresh. Fields the response does not carry keep what the card already
 * showed; a settled build never claims a PDF receipt it was not given.
 */
export function applyRetainedBuild<T extends RequestWithArtifact>(
  current: T[],
  build: RetainedBuildResult,
): T[] {
  return current.map((item) =>
    item.reportId === build.reportId
      ? {
          ...item,
          artifact: {
            reportStatus:
              build.reportStatus ?? item.artifact?.reportStatus ?? item.reportStatus ?? 'unknown',
            status: build.status,
            operationKey: build.operationKey,
            lastErrorCode: build.lastErrorCode ?? null,
            pdf: build.pdf ?? item.artifact?.pdf ?? null,
          },
        }
      : item,
  );
}

/** Waits between re-reads while a settled card still lacks its PDF receipt. */
export const RECEIPT_REFRESH_DELAYS_MS = [1000, 1500, 2000, 3000, 4000, 5000] as const;

/**
 * A build answer proves the artifact settled but carries no receipt, and a
 * stale list read cannot supply one. Until a read returns the receipt the
 * card has nothing to release, so it must read again rather than stand still.
 */
export function awaitsReceipt(requests: RequestWithArtifact[]): boolean {
  return requests.some((item) => item.artifact?.status === 'settled' && !item.artifact.pdf);
}

/** Delay before the next re-read, or null when none is needed or attempts are spent. */
export function nextReceiptRefreshDelay(attempt: number, waiting: boolean): number | null {
  if (!waiting) return null;
  return RECEIPT_REFRESH_DELAYS_MS[attempt] ?? null;
}
