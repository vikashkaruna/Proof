import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { publicControlPayloadV2Schema } from '@axiom/types';
import { extractPublicEvidenceV2 } from './public-evidence-extractor-v2';
import {
  PUBLIC_EVIDENCE_V2_CODEC,
  bindPublicEvidenceV2,
  encodePublicEvidencePayloadV2,
  readPublicEvidenceV2,
  verifyPublicControlSourceV2,
} from './public-evidence-codec-v2';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const binding = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  engagementId: '22222222-2222-4222-8222-222222222222',
  checkId: '33333333-3333-4333-8333-333333333333',
  assessmentDate: '2026-10-15',
};
function payload() {
  const html = Buffer.from('<p>Privacy policy — गोपनीयता সম্মতি 😀 é</p>');
  return extractPublicEvidenceV2({
    pages: [{ page: 'root', state: 'examined', html, contentSha256: hash(html) }],
  });
}
function record() {
  const value = encodePublicEvidencePayloadV2(payload());
  return {
    codec: value.codec,
    payloadBytes: value.payloadBytes,
    payloadSha256: value.payloadSha256,
  };
}
it('hashes a payload independently of scope/date without a hash self-reference', () => {
  const value = payload();
  const encoded = encodePublicEvidencePayloadV2(value);
  expect(encoded.payloadText).toBe(canonicalJson(value));
  expect(encoded.payloadSha256).toBe(hash(encoded.payloadBytes));
  expect(encoded.payloadText).not.toMatch(
    /projectionSha256|tenantId|engagementId|checkId|assessmentDate/,
  );
  const first = bindPublicEvidenceV2(value, binding);
  const second = bindPublicEvidenceV2(value, {
    ...binding,
    tenantId: '44444444-4444-4444-8444-444444444444',
    assessmentDate: '2026-10-16',
  });
  expect(first.payloadSha256).toBe(second.payloadSha256);
  expect(first.source.tenantId).not.toBe(second.source.tenantId);
  expect(first.source.projectionSha256).toBe(encoded.payloadSha256);
  expect(verifyPublicControlSourceV2(first.source)).toEqual(first.source);
});
it('is independent of object insertion order and preserves exact Unicode without normalization', () => {
  const value = payload();
  const reverse = Object.fromEntries(Object.entries(value).reverse());
  expect(encodePublicEvidencePayloadV2(reverse)).toEqual(encodePublicEvidencePayloadV2(value));
  const bound = bindPublicEvidenceV2(value, binding);
  const decoded = readPublicEvidenceV2(record(), binding);
  expect(decoded.source).toEqual(bound.source);
  expect(decoded.payloadText).toContain('गोपनीयता');
  expect(decoded.payloadText).toContain('😀');
  expect(decoded.payloadText).toContain('é');
  expect(decoded.payloadBytes).toEqual(new TextEncoder().encode(decoded.payloadText));
});
it.each([
  'whitespace',
  'key_order',
  'duplicate',
  'escaped_duplicate',
  'invalid_utf8',
  'bom',
  'wrong_hash',
  'mutated_bytes',
  'empty',
  'oversized',
  'unknown_codec',
  'unknown_key',
])('rejects noncanonical or corrupted retained bytes: %s', (mode) => {
  const value = record();
  switch (mode) {
    case 'whitespace':
      value.payloadBytes = new TextEncoder().encode(
        ' ' + new TextDecoder().decode(value.payloadBytes),
      );
      break;
    case 'key_order':
      value.payloadBytes = new TextEncoder().encode(JSON.stringify(payload()));
      break;
    case 'duplicate':
      value.payloadBytes = new TextEncoder().encode(
        new TextDecoder()
          .decode(value.payloadBytes)
          .replace('"version":2', '"version":2,"version":2'),
      );
      break;
    case 'escaped_duplicate':
      value.payloadBytes = new TextEncoder().encode(
        new TextDecoder()
          .decode(value.payloadBytes)
          .replace('"version":2', '"version":2,"ver\\u0073ion":2'),
      );
      break;
    case 'invalid_utf8':
      value.payloadBytes = Uint8Array.from([0xc3, 0x28]);
      break;
    case 'bom':
      value.payloadBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...value.payloadBytes]);
      break;
    case 'wrong_hash':
      value.payloadSha256 = 'b'.repeat(64);
      break;
    case 'mutated_bytes':
      value.payloadBytes[10] = 0;
      break;
    case 'empty':
      value.payloadBytes = new Uint8Array();
      break;
    case 'oversized':
      value.payloadBytes = new Uint8Array(512 * 1024 + 1);
      break;
    case 'unknown_codec':
      Object.assign(value, { codec: 'permissive-json' });
      break;
    case 'unknown_key':
      Object.assign(value, { source: 'caller-chosen' });
      break;
  }
  if (!['wrong_hash', 'mutated_bytes'].includes(mode))
    value.payloadSha256 = hash(value.payloadBytes);
  expect(() => readPublicEvidenceV2(value, binding)).toThrow(/^public_evidence_codec_refused$/);
});
it.each([
  'hash',
  'text',
  'locator_hash',
  'scope',
  'missing_binding',
  'fake_hash_in_payload',
  'nan',
  'fraction',
  'lone_high',
  'lone_low',
])('refuses invalid payload/source/binding: %s', (mode) => {
  const value = bindPublicEvidenceV2(payload(), binding);
  if (mode === 'hash') {
    value.source.projectionSha256 = 'b'.repeat(64);
    expect(() => verifyPublicControlSourceV2(value.source)).toThrow();
    return;
  }
  if (mode === 'text') {
    value.source.candidates[0]!.excerpt = 'Changed public notice';
    expect(() => verifyPublicControlSourceV2(value.source)).toThrow();
    return;
  }
  if (mode === 'locator_hash') {
    value.source.candidates[0]!.locator.contentSha256 = 'b'.repeat(64);
    expect(() => verifyPublicControlSourceV2(value.source)).toThrow();
    return;
  }
  if (mode === 'scope') {
    expect(() => bindPublicEvidenceV2(payload(), { ...binding, tenantId: 'invalid' })).toThrow();
    return;
  }
  if (mode === 'missing_binding') {
    expect(() => bindPublicEvidenceV2(payload(), {})).toThrow();
    return;
  }
  const input = payload();
  if (mode === 'fake_hash_in_payload') Object.assign(input, { projectionSha256: 'a'.repeat(64) });
  if (mode === 'nan') input.candidates[0]!.ordinal = NaN;
  if (mode === 'fraction') input.candidates[0]!.ordinal = 1.5;
  if (mode === 'lone_high') input.candidates[0]!.excerpt = 'private\ud800';
  if (mode === 'lone_low') input.candidates[0]!.excerpt = 'private\udc00';
  expect(() => encodePublicEvidencePayloadV2(input)).toThrow(/^public_evidence_codec_refused$/);
});
it('copies caller bytes and rejects invalid retained scope without leaking content', () => {
  const value = record();
  const before = Uint8Array.from(value.payloadBytes);
  const result = readPublicEvidenceV2(value, binding);
  result.payloadBytes[0] = 0;
  expect(value.payloadBytes).toEqual(before);
  expect(() => readPublicEvidenceV2(value, { ...binding, private: 'never-echo' })).toThrow(
    /^public_evidence_codec_refused$/,
  );
  expect(
    publicControlPayloadV2Schema.safeParse({ ...payload(), tenantId: binding.tenantId }).success,
  ).toBe(false);
});
it('pins a cross-language canonical fixture for Python canonical_json parity', () => {
  const value = {
    version: 2,
    extractorVersion: 'static-public-2',
    pages: [
      {
        page: 'root',
        state: 'examined',
        contentSha256: 'a'.repeat(64),
        truncated: false,
        coverageReasons: [],
      },
    ],
    candidates: [],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  };
  const encoded = encodePublicEvidencePayloadV2(value);
  expect(encoded.codec).toBe(PUBLIC_EVIDENCE_V2_CODEC);
  expect(encoded.payloadText).toBe(
    '{"candidates":[],"candidatesTruncated":false,"extractorVersion":"static-public-2","pages":[{"contentSha256":"' +
      'a'.repeat(64) +
      '","coverageReasons":[],"page":"root","state":"examined","truncated":false}],"requiresHumanReview":true,"scope":"bounded_public_pages","version":2}',
  );
});
