import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { loadAssessmentRetentionEnv } from '@axiom/config';
import {
  AssessmentRetention,
  retentionReceipt,
  type RetentionReceipt,
} from './workloads/assessment-retention.js';

/** Explicit backend entrypoint; ordinary BFF startup never runs maintenance. */
export async function runAssessmentRetention(
  args: string[],
  dependencies: {
    create: () => Pick<AssessmentRetention, 'purgeNext'>;
    report: (receipt: RetentionReceipt) => void;
    wait: () => Promise<void>;
  },
): Promise<void> {
  if (args.length !== 1 || !['--once', '--watch'].includes(args[0]!))
    throw new Error('Use --once or --watch.');
  const retention = dependencies.create();
  do {
    const receipt = retentionReceipt.parse(await retention.purgeNext());
    dependencies.report(receipt);
    if (receipt.status === 'review') throw new Error('Assessment retention requires review.');
    if (args[0] === '--once') return;
    // Failures stop the loop; a timed-out RPC may still commit. No retry storm.
    await dependencies.wait();
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  try {
    await runAssessmentRetention(process.argv.slice(2), {
      create: () => {
        const env = loadAssessmentRetentionEnv();
        const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        return new AssessmentRetention(db, {
          retentionDays: env.AXIOM_ASSESSMENT_DISPATCH_RETENTION_DAYS,
        });
      },
      report: (receipt) => process.stdout.write(JSON.stringify(receipt) + '\n'),
      wait: () => sleep(60000, undefined, { signal: shutdown.signal }),
    });
  } catch {
    if (!shutdown.signal.aborted) {
      console.error('Assessment retention stopped; inspect configuration and durable receipts.');
      process.exitCode = 1;
    }
  }
}
