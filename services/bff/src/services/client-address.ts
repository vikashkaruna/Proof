import { createHash } from 'node:crypto';

/**
 * W1 · R-08 — a client address you are allowed to rate-limit on.
 *
 * `x-forwarded-for` is appended to by each hop, so it reads
 *
 *     <whatever the caller sent>, <hop 1's view>, ..., <hop N's view>
 *
 * Only the entries written by infrastructure we control mean anything; every
 * byte to their left is caller input. A limiter keyed on an unvalidated header
 * is not a weaker defence, it is a new attack: the caller picks a victim's key
 * and exhausts it, which is exactly what the per-session budget exists to
 * prevent. So this returns null unless the deployment has told us how many
 * hops to discard, and null means the address-scoped budget does not apply.
 *
 * `AXIOM_TRUSTED_PROXY_HOPS` is topology, per the W0.0 rule, so it varies by
 * environment while the behaviour here does not.
 */

/** IPv4, or IPv6 in the forms that appear in this header. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f:]+$/i;

function normalise(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // `[2001:db8::1]:443` — bracketed v6 with a port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  // `1.2.3.4:443` — v4 with a port. A bare v6 has more than one colon, so
  // splitting on a single colon cannot damage one.
  else if ((value.match(/:/g) ?? []).length === 1 && value.includes('.')) {
    value = value.split(':')[0] ?? value;
  }

  const v4 = IPV4.exec(value);
  if (v4) {
    return v4.slice(1, 5).every((octet) => Number(octet) <= 255) ? value : null;
  }
  // Must contain a colon to be v6 at all; this also rejects hostnames and the
  // literal "unknown" that some proxies emit.
  return value.includes(':') && IPV6.test(value) ? value.toLowerCase() : null;
}

/**
 * The address the trusted hops attest to, or null when we cannot know it.
 *
 * Each proxy appends the address of the peer it received the connection FROM,
 * and the origin appends nothing. So with one trusted proxy the client address
 * is the last entry; with two it is the second from last; in general it is
 * `parts[parts.length - hops]`.
 *
 * The off-by-one here is not academic. `parts.length - 1 - hops` selects one
 * entry further left, and with a single proxy and a caller who sent
 * `x-forwarded-for: 9.9.9.9` that is the caller's own value — the limiter
 * would then be keyed on whatever an attacker chose.
 */
export function trustedClientAddress(
  forwardedFor: string | undefined | null,
  hops: number,
): string | null {
  // 0 is not "trust the last entry" — with nothing in front of us the whole
  // header is caller input.
  if (!Number.isInteger(hops) || hops <= 0) return null;
  if (!forwardedFor) return null;

  const parts = forwardedFor
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const index = parts.length - hops;
  // A header shorter than the deployment says it should be means a request
  // that did not come through the proxies we think it did. Refuse to guess.
  if (index < 0 || index >= parts.length) return null;

  return normalise(parts[index] as string);
}

/**
 * The rate-limit subject for an address.
 *
 * `request_rate_limits` rows are not swept, so a raw address would persist in
 * the database indefinitely. Under the DPDP Act that is personal data we have
 * no reason to keep, and a limiter does not need the address itself — only a
 * stable key.
 *
 * This is pseudonymisation, not anonymisation, and the difference is worth
 * being precise about: the IPv4 space is 2^32, so anyone holding this table
 * can recover an address by exhaustive hashing. What it buys is that plain
 * addresses are not sitting in a table, and that a leak of it is not a leak of
 * a readable list. Making it irreversible would need a secret this service is
 * deliberately not given — configuration refuses to reuse the signing or MFA
 * keys, and introducing another is a deployment decision, not a code one.
 */
export function clientAddressKey(address: string): string {
  return createHash('sha256').update(`axiom-client-address:${address}`, 'utf8').digest('hex');
}
