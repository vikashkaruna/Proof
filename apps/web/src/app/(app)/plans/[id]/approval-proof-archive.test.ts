import { describe, expect, it } from 'vitest';
import { parseArchiveStatus } from './approval-proof-archive';

const tokenId = '11111111-1111-4111-8111-111111111111';
const status = {
  archiveId: '22222222-2222-4222-8222-222222222222',
  tokenId,
  status: 'settled',
  sourceSha256: 'a'.repeat(64),
  versionId: 'provider-version-1',
  reviewed: false,
  retainUntil: '2033-10-01T00:00:00.000Z',
};

describe('approval archive response boundary', () => {
  it('accepts an exact settled status for the selected approval token', () => {
    expect(parseArchiveStatus(status, tokenId).versionId).toBe('provider-version-1');
  });

  it.each([
    { ...status, tokenId: '33333333-3333-4333-8333-333333333333' },
    { ...status, sourceSha256: 'not-a-hash' },
    { ...status, status: 'released', versionId: null },
    { ...status, status: 'pending', versionId: 'provider-version-1' },
    { ...status, reviewed: 'yes' },
  ])('refuses malformed or cross-token success bodies before presenting proof', (body) => {
    expect(() => parseArchiveStatus(body, tokenId)).toThrow('Archive status is unconfirmed');
  });
});
