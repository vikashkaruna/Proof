import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { acceptanceErrorLocation } from '../../scripts/lib/acceptance-error-location.js';

/** Publish static test outcomes and allowlisted source locations only. */
export default class AcceptanceReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    const title = test
      .titlePath()
      .join(' / ')
      .replace(/[\r\n]/g, ' ');
    console.log(`${result.status}: ${title} (${Math.max(0, Math.floor(result.duration))}ms)`);
    if (result.status === 'failed' || result.status === 'timedOut') {
      const locations = new Set(
        result.errors.map((error) => acceptanceErrorLocation(error.location)).filter(Boolean),
      );
      for (const location of locations) console.log(`Acceptance failure location: ${location}`);
    }
  }
  onEnd(result: FullResult) {
    console.log(`Browser acceptance finished: ${result.status}`);
  }
  // Test stdout/stderr/errors are intentionally left to the private JSON reporter.
}
