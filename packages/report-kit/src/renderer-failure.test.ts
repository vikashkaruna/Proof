import { describe, expect, it } from 'vitest';
import { describeChromiumFailure } from './renderer';

function execError(extra: Record<string, unknown>) {
  return Object.assign(new Error('Command failed: chromium'), extra);
}

describe('describeChromiumFailure', () => {
  it('says a timeout kill was a timeout, with its signal', () => {
    const text = describeChromiumFailure(
      'headless=new',
      execError({ killed: true, signal: 'SIGKILL', code: null }),
    );
    expect(text).toContain('headless=new');
    expect(text).toContain('killed (timeout)');
    expect(text).toContain('signal=SIGKILL');
    expect(text).not.toContain('code=');
  });

  it('reports the exit code and only the tail of stderr, on one line', () => {
    const stderr = `${'x'.repeat(500)}\nFatal: no display\n`;
    const text = describeChromiumFailure('headless', execError({ code: 127, stderr }));
    expect(text).toContain('code=127');
    expect(text).toContain('Fatal: no display');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(400);
  });

  it('falls back to a bounded message and never throws on non-errors', () => {
    expect(describeChromiumFailure('headless', new Error('plain failure'))).toContain(
      'plain failure',
    );
    expect(describeChromiumFailure('headless', 'oops')).toBe('headless: unknown failure');
    expect(describeChromiumFailure('headless', new Error('m'.repeat(1000))).length).toBeLessThan(
      260,
    );
  });
});
