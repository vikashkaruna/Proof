import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePdfText } from '../../tests/e2e/pdf-text.js';
test('PDF assertions compare text independently of line wrapping and page breaks', () => {
  assert.equal(
    normalizePdfText('Synthetic public\nwebsite\t inventory\f'),
    'Synthetic public website inventory',
  );
});
test('normalization retains all substantive text, identifiers and estimate values', () => {
  const text = normalizePdfText(
    'Posture score:\n99\nEstimated exposure ₹\u00a01000\nDPDPA-GOV-001',
  );
  assert.match(text, /Posture score\s*[:=]?\s*\d/);
  assert.match(text, /Estimated exposure\s*[:=]?\s*[₹0-9]/);
  assert.ok(text.includes('DPDPA-GOV-001'));
  assert.equal(normalizePdfText('privacy-\nnotice'), 'privacy- notice');
});
