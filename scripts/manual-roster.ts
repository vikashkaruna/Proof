/**
 * Audited manual-test roster operator (e448).
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     pnpm exec tsx scripts/manual-roster.ts --plan <plan.json> \
 *       --audit-out <file> [--credentials-out <file>] [--apply]
 *
 * Without --apply it checks every precondition and prints the plan; nothing
 * is written. With --apply it renames in place (UUID, factors, password,
 * memberships and history preserved) and creates clean manual identities
 * without MFA. The audit file holds no secrets; generated passwords go only to
 * --credentials-out, created owner-only and never printed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  RosterPlanSchema,
  RosterRefused,
  applyRoster,
  checkRoster,
  restRosterApi,
} from './lib/manual-roster';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const planPath = arg('--plan');
  const auditOut = arg('--audit-out');
  const credentialsOut = arg('--credentials-out');
  const apply = process.argv.includes('--apply');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!planPath || !auditOut || !url || !key)
    throw new RosterRefused(
      '--plan, --audit-out, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
    );
  const plan = RosterPlanSchema.parse(JSON.parse(readFileSync(planPath, 'utf8')));
  if (apply && plan.creates.length > 0 && !credentialsOut)
    throw new RosterRefused('--credentials-out is required to create accounts');
  if (credentialsOut && existsSync(credentialsOut))
    throw new RosterRefused('--credentials-out already exists; refusing to overwrite credentials');
  const api = restRosterApi(url.replace(/\/$/, ''), key);

  if (!apply) {
    const audit = await checkRoster(plan, api);
    writeFileSync(
      auditOut,
      JSON.stringify({ mode: 'dry-run', at: new Date().toISOString(), audit }, null, 2),
      {
        mode: 0o600,
      },
    );
    for (const e of audit)
      console.log(
        `${e.status.padEnd(15)} ${e.action} ${e.from ?? e.email ?? ''}${e.to ? ` -> ${e.to}` : ''}`,
      );
    console.log('Dry run only. Re-run with --apply to write.');
    return;
  }
  const { audit, credentials } = await applyRoster(plan, api);
  writeFileSync(
    auditOut,
    JSON.stringify({ mode: 'apply', at: new Date().toISOString(), audit }, null, 2),
    {
      mode: 0o600,
    },
  );
  if (credentials.length > 0)
    writeFileSync(credentialsOut!, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
  for (const e of audit)
    console.log(
      `${e.status.padEnd(15)} ${e.action} ${e.from ?? e.email ?? ''}${e.to ? ` -> ${e.to}` : ''}`,
    );
  console.log(
    `Audit written. ${credentials.length} credential(s) written owner-only, not printed.`,
  );
}

main().catch((err) => {
  console.error(err instanceof RosterRefused ? `Refused: ${err.message}` : (err as Error).message);
  process.exit(1);
});
