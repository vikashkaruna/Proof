/** Exact fixed-point formatting of a nonnegative IEEE-754 value, using
 * round-to-nearest, ties-to-even as the pinned Python renderer does.
 * This pure helper grants no source, invocation or publication authority.
 */
export function prativedanFixedDecimal(value: number, places: 0 | 2): string {
  if (!Number.isFinite(value) || value < 0 || (places !== 0 && places !== 2))
    throw new RangeError('Invalid renderer decimal');
  const sign = Object.is(value, -0) ? '-' : '';
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  let numerator = significand * 10n ** BigInt(places);
  let denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const doubledRemainder = (numerator % denominator) * 2n;
  if (doubledRemainder > denominator || (doubledRemainder === denominator && rounded % 2n === 1n))
    rounded += 1n;
  if (places === 0) return sign + rounded.toString();
  const digits = rounded.toString().padStart(places + 1, '0');
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
