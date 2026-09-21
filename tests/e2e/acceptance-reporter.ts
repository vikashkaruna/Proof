import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** Only static test titles and outcomes may enter the public CI log. */
export default class AcceptanceReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    const title = test
      .titlePath()
      .join(' / ')
      .replace(/[\r\n]/g, ' ');
    console.log(`${result.status}: ${title}`);
  }
  onEnd(result: FullResult) {
    console.log(`Browser acceptance finished: ${result.status}`);
  }
  // Test stdout/stderr/errors are intentionally left to the private JSON reporter.
}
