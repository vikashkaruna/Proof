import assert from 'node:assert/strict';
export interface Evidence {
  schemaVersion: number;
  passed: true;
  completedAt: string;
  kind: string;
  deploymentId: string;
  environment: string;
  topology: string;
  revision: string;
  bffUrl?: string;
  webUrl?: string;
  outcomes: Record<string, number | boolean>;
}
export function compareAcceptance(results: Evidence[]): void {
  assert(results.length >= 2, 'Supply results from at least two distinct deployments');
  const baseline = results[0]!;
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const r of results) {
    assert(
      r.passed === true && Number.isFinite(Date.parse(r.completedAt)),
      'Only completed successful runs may prove parity',
    );
    assert(/^[a-f0-9]{40}$/.test(r.revision), 'Missing exact source revision');
    assert(['local-docker', 'remote'].includes(r.topology), 'Missing deployment topology');
    assert(
      r.topology === baseline.topology,
      'Do not substitute local Docker for remote deployment evidence',
    );
    assert(
      Object.values(r.outcomes).every(
        (v) =>
          v === true ||
          (r.kind === 'deployed-http' &&
            Number.isInteger(v) &&
            Number(v) >= 100 &&
            Number(v) <= 599),
      ),
      'Failed or malformed outcomes',
    );
    assert(
      r.schemaVersion === 1 && ['deployed-http', 'deployed-browser'].includes(r.kind),
      'Embedded/local-label evidence cannot prove deployed parity',
    );
    assert(
      r.kind === baseline.kind && r.revision === baseline.revision,
      'Compare the same suite and exact source revision',
    );
    assert(!ids.has(r.deploymentId), 'Cannot compare a deployment to itself');
    ids.add(r.deploymentId);
    const endpoint = r.kind === 'deployed-http' ? r.bffUrl : r.webUrl;
    assert(
      endpoint && !endpoints.has(endpoint),
      'Each result needs a distinct deployed service endpoint',
    );
    endpoints.add(endpoint);
    assert(Object.keys(r.outcomes).length > 0, 'Empty acceptance evidence');
    assert.deepEqual(r.outcomes, baseline.outcomes, 'Behavioral divergence between deployments');
  }
  assert(
    new Set(results.map((r) => r.environment)).size >= 2,
    'Use distinct environment configurations',
  );
}
