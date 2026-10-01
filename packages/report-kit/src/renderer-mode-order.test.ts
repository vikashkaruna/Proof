import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHtmlToPdf } from './renderer';

/** A stand-in browser: logs the headless mode it was given, then fails or writes a PDF. */
function fakeChrome(failModes: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-chrome-'));
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'chrome');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$1" >> '${log}'
case " ${failModes.join(' ')} " in *" $1 "*) echo "mode refused" >&2; exit 1;; esac
for a in "$@"; do case "$a" in --print-to-pdf=*) out="\${a#--print-to-pdf=}";; esac; done
printf '%%PDF-1.4\\n' > "$out"
head -c 600 /dev/zero | tr '\\0' ' ' >> "$out"
printf '\\n%%%%EOF\\n' >> "$out"
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

describe('renderHtmlToPdf waits for the browser, not for helpers holding its pipes', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns as soon as the browser exits even if a helper keeps stderr open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-chrome-'));
    const bin = join(dir, 'chrome');
    writeFileSync(
      bin,
      `#!/bin/sh
for a in "$@"; do case "$a" in --print-to-pdf=*) out="\${a#--print-to-pdf=}";; esac; done
printf '%%PDF-1.4\n' > "$out"
head -c 600 /dev/zero | tr '\0' ' ' >> "$out"
printf '\n%%%%EOF\n' >> "$out"
( sleep 8 ) &
exit 0
`,
    );
    chmodSync(bin, 0o755);
    vi.stubEnv('CHROME_PATH', bin);
    const started = Date.now();
    const result = await renderHtmlToPdf('<p>x</p>', { timeoutMs: 20_000 });
    expect(result.renderer).toBe('chromium');
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('renderHtmlToPdf headless mode order', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('tries classic --headless first so a runner where --headless=new stalls costs nothing', async () => {
    const chrome = fakeChrome([]);
    vi.stubEnv('CHROME_PATH', chrome.bin);
    const result = await renderHtmlToPdf('<p>x</p>', {});
    expect(result.renderer).toBe('chromium');
    expect(chrome.calls()).toEqual(['--headless']);
  });

  it('falls back to --headless=new and says why classic failed', async () => {
    const chrome = fakeChrome(['--headless']);
    vi.stubEnv('CHROME_PATH', chrome.bin);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await renderHtmlToPdf('<p>x</p>', {});
    expect(result.renderer).toBe('chromium');
    expect(chrome.calls()).toEqual(['--headless', '--headless=new']);
    expect(warn.mock.calls[0]?.join(' ')).toContain('mode refused');
  });

  it('reports both failures when neither mode works', async () => {
    const chrome = fakeChrome(['--headless', '--headless=new']);
    vi.stubEnv('CHROME_PATH', chrome.bin);
    const failure = await renderHtmlToPdf('<p>x</p>', {
      requireChromium: true,
      documentDate: '2026-01-01T00:00:00.000Z',
    }).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(failure).toMatch(/headless code=1 .*mode refused; headless=new code=1 .*mode refused/);
  });
});
