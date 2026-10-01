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

export const retainedBuildResultSchema = retainedArtifactSchema.extend({
  reportId: z.uuid(),
  status: z.enum(['pending', 'settled']),
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

/** Project the authoritative build response immediately, before any list refresh. */
export function applyRetainedBuild<T extends RequestWithArtifact>(
  current: T[],
  build: RetainedBuildResult,
): T[] {
  return current.map((item) =>
    item.reportId === build.reportId
      ? {
          ...item,
          artifact: {
            reportStatus: build.reportStatus,
            status: build.status,
            operationKey: build.operationKey,
            lastErrorCode: build.lastErrorCode,
            pdf: build.pdf,
          },
        }
      : item,
  );
}
