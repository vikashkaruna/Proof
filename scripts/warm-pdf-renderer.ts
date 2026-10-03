/**
 * Render one trivial PDF through the report renderer, with a generous timeout.
 *
 * The provider browser journeys build retained PDFs with headless Chromium. The
 * first run of that browser on a fresh machine can take far longer than the
 * renderer's 30 s budget (cold disk, just-downloaded binary), and the failure
 * surfaced mid-suite as a 503 or a reset connection on whichever journey built
 * the first PDF. Doing it once up front moves a cold start out of the journeys
 * and fails early, with the renderer's own explanation, if Chromium cannot run.
 */
import { basename } from 'node:path';
import { findChromiumExecutable, renderHtmlToPdf } from '../packages/report-kit/src/renderer.js';

async function main() {
  const started = Date.now();
  try {
    const executable = findChromiumExecutable();
    console.log(`PDF renderer binary: ${executable ? basename(executable) : 'unavailable'}`);
    const result = await renderHtmlToPdf('<!doctype html><title>warm-up</title><p>warm-up</p>', {
      requireChromium: true,
      documentDate: '2026-01-01T00:00:00.000Z',
      // The renderer retries once with a second headless mode, so two attempts must
      // fit inside the harness's 300 s limit.
      timeoutMs: 120_000,
    });
    if (result.renderer !== 'chromium' || result.byteLength < 500)
      throw new Error(`Unexpected renderer output: ${result.renderer}, ${result.byteLength} bytes`);
    console.log(`PDF renderer warm-up passed in ${Date.now() - started} ms`);
  } catch (cause) {
    console.error(
      `PDF renderer warm-up failed after ${Date.now() - started} ms: ${
        cause instanceof Error ? cause.message : 'unknown'
      }`,
    );
    process.exit(1);
  }
}

void main();
