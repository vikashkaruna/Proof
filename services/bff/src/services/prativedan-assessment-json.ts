/** Refuse JSON number tokens whose exact decimal value would change in JS.
 * Retained bytes remain untouched; this parser grants no authority.
 */
import { parsePrativedanJson, PrativedanDraftRefused } from './prativedan-draft-source.js';

function decimalIdentity(token: string): string {
  if (token.length > 128) throw new PrativedanDraftRefused();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new PrativedanDraftRefused();
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }
  return `${match[1]}${digits}e${exponent}`;
}

export function parsePrativedanAssessmentJson(text: string): unknown {
  const parsed = parsePrativedanJson(text);
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('"')) continue;
    const value = Number(token);
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      decimalIdentity(token) !== decimalIdentity(value.toString())
    )
      throw new PrativedanDraftRefused();
  }
  return parsed;
}
