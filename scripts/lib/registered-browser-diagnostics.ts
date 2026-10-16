/** Safe CI evidence only. Raw browser reports remain private. */
import { constants, openSync, fstatSync, readSync, closeSync, lstatSync } from 'node:fs';
import { acceptanceErrorLocation } from './acceptance-error-location.js';
const title =
  'finalized source, released board PDF, and source-bound Pramaan dossier use exact retained versions';
const statuses = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const matchers = [
  'toBeVisible',
  'toBeEnabled',
  'toBeDisabled',
  'toHaveText',
  'toContainText',
  'toHaveCount',
  'toHaveURL',
  'toBe',
  'toEqual',
  'toMatchObject',
] as const;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 64) : []);
export function registeredBrowserDiagnostics(
  input: unknown,
  lifecycle: {
    exitCode: unknown;
    signal: unknown;
    phase: unknown;
    report: 'available' | 'missing' | 'refused';
  },
) {
  const results: { caseId: string; status: string; location?: string; matcher: string }[] = [];
  function visit(value: unknown, depth: number) {
    if (depth > 8) return;
    const suite = record(value);
    for (const candidate of list(suite.specs)) {
      const spec = record(candidate);
      if (
        spec.title !== title ||
        typeof spec.file !== 'string' ||
        !/(?:^|\/)board-reports-provider\.spec\.ts$/.test(spec.file)
      )
        continue;
      for (const test of list(spec.tests))
        for (const candidate of list(record(test).results)) {
          const result = record(candidate);
          const errors = list(result.errors);
          const location = errors
            .map((error) => acceptanceErrorLocation(record(error).location))
            .find(Boolean);
          // Match only an exact known assertion token; never return message text.
          const matcher =
            matchers.find((name) =>
              errors.some(
                (error) =>
                  typeof record(error).message === 'string' &&
                  new RegExp(`\\b${name}\\(`).test(record(error).message as string),
              ),
            ) ?? 'unknown';
          results.push({
            caseId: 'registered-source-board-auditor-recovery',
            status:
              typeof result.status === 'string' && statuses.has(result.status)
                ? result.status
                : 'unknown',
            ...(location ? { location } : {}),
            matcher,
          });
        }
    }
    for (const child of list(suite.suites)) visit(child, depth + 1);
  }
  visit(input, 0);
  const phase =
    lifecycle.phase === 'normal-auth-public-source-browser-submission-wait'
      ? 'submission-wait'
      : typeof lifecycle.phase === 'string' &&
          lifecycle.phase.startsWith('normal-auth-public-report-')
        ? 'reports'
        : lifecycle.phase === 'complete'
          ? 'complete'
          : 'other';
  const exitCode =
    Number.isInteger(lifecycle.exitCode) &&
    typeof lifecycle.exitCode === 'number' &&
    lifecycle.exitCode >= 0 &&
    lifecycle.exitCode <= 255
      ? lifecycle.exitCode
      : null;
  const signal = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(
    String(lifecycle.signal),
  )
    ? String(lifecycle.signal)
    : null;
  return {
    version: 1,
    kind: 'sanitized-registered-browser-diagnostics',
    phase,
    report: lifecycle.report,
    exitCode,
    signal,
    category: results.length
      ? 'case-result'
      : exitCode !== null && exitCode !== 0
        ? 'child-exit-before-result'
        : signal !== null
          ? 'child-signal-before-result'
          : 'no-case-result',
    results: results.slice(0, 4),
  };
}
/** Refuse non-regular files/symlinks and bound the actual read, not just stat size. */
export function readRegisteredBrowserDiagnostics(
  path: string,
  lifecycle: { exitCode: unknown; signal: unknown; phase: unknown },
) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4_194_304)
      throw new Error('private report refused');
    const bytes = Buffer.alloc(4_194_305);
    let count = 0,
      size: number;
    do {
      size = readSync(descriptor, bytes, count, bytes.length - count, null);
      count += size;
    } while (size > 0 && count < bytes.length);
    if (count > 4_194_304) throw new Error('private report refused');
    return registeredBrowserDiagnostics(
      JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown,
      { ...lifecycle, report: 'available' },
    );
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return registeredBrowserDiagnostics(undefined, {
      ...lifecycle,
      report: missing ? 'missing' : 'refused',
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** A fresh run may not overwrite or silently reuse an earlier evidence result. */
export function assertRegisteredDiagnosticDestinationAbsent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error('registered browser diagnostic preflight refused');
  }
  throw new Error(
    'registered browser diagnostic target exists; archive prior owned evidence before a fresh attempt',
  );
}
