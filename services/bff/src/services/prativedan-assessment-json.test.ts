import { describe, expect, it } from 'vitest';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

describe('lossless dedicated assessment JSON numbers', () => {
  it.each(['0', '-0', '1.0', '1e0', '0.1', '1.25e2', '9007199254740991', '5e-324'])(
    'accepts exact %s',
    (token) => {
      expect(
        parsePrativedanAssessmentJson(`{"value":${token},"text":"9007199254740991.1"}`),
      ).toEqual({ value: Number(token), text: '9007199254740991.1' });
    },
  );
  it.each([
    '9007199254740991.1',
    '9007199254740992',
    '1.0000000000000001',
    '99.9999999999999999',
    '1e-400',
    '1e400',
    '0.10000000000000001',
  ])('refuses lossy %s even in metadata', (token) => {
    expect(() => parsePrativedanAssessmentJson(`{"metadata":{"value":${token}}}`)).toThrow();
  });
  it('skips escaped numeric text and rejects duplicate keys', () => {
    expect(parsePrativedanAssessmentJson('{"text":"\\\"1.0000000000000001"}')).toEqual({
      text: '"1.0000000000000001',
    });
    expect(() => parsePrativedanAssessmentJson('{"a":1,"a":1}')).toThrow();
  });
});
