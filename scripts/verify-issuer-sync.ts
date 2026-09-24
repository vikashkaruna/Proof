/** Real protected health/trust probe. Emits no node/admin response or SVID. */
import assert from 'node:assert/strict';
import { access, stat, writeFile } from 'node:fs/promises';
import {
  IssuerSyncHealth,
  SyncedWorkloadTrust,
} from '../services/bff/src/workloads/issuer-sync-health.js';
import { WorkloadApiJwtTrust } from '../services/bff/src/workloads/workload-api-trust.js';

async function main() {
  const [mode, node] = process.argv.slice(2);
  assert(mode && ['healthy', 'refused', 'cached-refused'].includes(mode) && node);
  assert.equal(process.getuid!(), 20000);
  const health = new IssuerSyncHealth(node);
  const source = new WorkloadApiJwtTrust({
    socketPath: '/run/workload/api.sock',
    trustDomains: [health.domain],
  });
  const trust = new SyncedWorkloadTrust(source, health);
  await assert.rejects(access('/run/spire-admin/api.sock'));
  if (mode === 'healthy') {
    const file = await stat('/run/spire-health/status.json');
    assert.equal(file.uid, 0);
    assert.equal(file.mode & 0o777, 0o644);
    await assert.rejects(writeFile('/run/spire-health/status.json', '{}'));
    await health.requireFresh();
    const value = await trust.load(health.domain);
    assert(value && value.validUntil > Date.now() && value.validUntil <= Date.now() + 10000);
    assert(await trust.stillCurrent(health.domain, value.revision));
  } else {
    assert.equal(await health.validUntil(), null);
    assert.equal(await trust.load(health.domain), null);
    if (mode === 'cached-refused') assert(await source.load(health.domain));
  }
  process.stdout.write('Issuer sync probe passed.\n');
}
main().catch(() => {
  process.stderr.write('Issuer sync probe refused.\n');
  process.exitCode = 1;
});
