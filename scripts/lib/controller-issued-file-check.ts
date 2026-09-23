/** Acceptance-only consumer of an actual operator-issued protected file. */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  controllerBackendCredentials,
  requireControllerBackend,
} from '../../services/bff/src/workloads/controller-files.js';
async function main() {
  const [filename, url, tenant] = process.argv.slice(2);
  assert(filename && url && tenant);
  const credential = await controllerBackendCredentials(
    filename,
    { AXIOM_REGION: 'ap-south-1', SUPABASE_URL: url },
    tenant,
  );
  const db = createClient(credential.url, credential.apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${credential.accessToken}` } },
  });
  await requireControllerBackend(db, tenant);
  process.stdout.write('issued-file-accepted\n');
}
main().catch(() => {
  process.stderr.write('Issued credential consumer refused.\n');
  process.exitCode = 1;
});
