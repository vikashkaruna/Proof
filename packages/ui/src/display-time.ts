/**
 * One place that turns stored instants into what a person reads.
 *
 * Storage, the ledger, signed receipts and every API stay UTC ISO-8601; only
 * display is zoned. The zone is a deployment parameter, default India
 * Standard Time (owner decision e439). Without this, `toLocaleString()` used
 * the browser's zone in client components and the container's zone (usually
 * UTC) in server components, so the same instant could read differently on
 * two screens — and `en-IN` is only a locale, not a time zone.
 *
 * The server reads `AXIOM_DISPLAY_TIMEZONE` at runtime and the root layout
 * publishes it on `<html data-display-tz>`, so client and server render the
 * same text (no hydration drift) and changing it needs no rebuild.
 */

export const DEFAULT_DISPLAY_TIME_ZONE = 'Asia/Kolkata';
const LOCALE = 'en-IN';

export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Server-side: the configured zone, refusing an invalid value rather than guessing. */
export function serverDisplayTimeZone(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): string {
  const configured = env.AXIOM_DISPLAY_TIMEZONE?.trim();
  if (!configured) return DEFAULT_DISPLAY_TIME_ZONE;
  if (!isValidTimeZone(configured))
    throw new Error(`AXIOM_DISPLAY_TIMEZONE is not a valid IANA time zone: ${configured}`);
  return configured;
}

export function displayTimeZone(): string {
  if (typeof document !== 'undefined') {
    const published = document.documentElement.dataset.displayTz;
    if (isValidTimeZone(published)) return published;
    return DEFAULT_DISPLAY_TIME_ZONE;
  }
  return serverDisplayTimeZone();
}

export type Instant = string | number | Date | null | undefined;

export function toDate(value: Instant): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatInDisplayZone(
  value: Instant,
  options: Intl.DateTimeFormatOptions,
  zone?: string,
): string {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    ...options,
    timeZone: zone ?? displayTimeZone(),
  }).format(date);
}

/** 2:05 pm */
export function formatTime(value: Instant, zone?: string): string {
  return formatInDisplayZone(value, { hour: 'numeric', minute: '2-digit' }, zone);
}

/** Offset of `zone` from UTC at `instant`, in minutes (IST = +330). */
function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The instant the display-zone calendar day containing `now` began. */
export function startOfDisplayDay(now: Date = new Date(), zone: string = displayTimeZone()): Date {
  const offset = zoneOffsetMinutes(now, zone);
  const local = new Date(now.getTime() + offset * 60_000);
  const midnightLocalAsUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  // Re-derive the offset at that midnight in case a DST change fell between.
  const guess = new Date(midnightLocalAsUtc - offset * 60_000);
  return new Date(midnightLocalAsUtc - zoneOffsetMinutes(guess, zone) * 60_000);
}

/**
 * Interpret a `datetime-local` value ("2026-10-17T14:05") as wall-clock time
 * in the display zone, never the browser's. Returns null for invalid input.
 */
export function displayLocalToInstant(
  local: string,
  zone: string = displayTimeZone(),
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const first = new Date(asUtc - zoneOffsetMinutes(new Date(asUtc), zone) * 60_000);
  return new Date(asUtc - zoneOffsetMinutes(first, zone) * 60_000);
}

/** The inverse, for pre-filling a `datetime-local` input from a stored instant. */
export function instantToDisplayLocal(value: Instant, zone: string = displayTimeZone()): string {
  const date = toDate(value);
  if (!date) return '';
  const shifted = new Date(date.getTime() + zoneOffsetMinutes(date, zone) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** 2:05:09 pm — for live activity feeds where seconds matter. */
export function formatClock(value: Instant, zone?: string): string {
  return formatInDisplayZone(
    value,
    { hour: 'numeric', minute: '2-digit', second: '2-digit' },
    zone,
  );
}
