import { describe, expect, it } from 'vitest';
import { addBrandedPdfMetadata } from './branded-pdf-metadata';

/** Structural PDF fixture only. Actual project Chromium/parser/visual proof is separate. */
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 0 /Kids [] >>'];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [n, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${n + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text +=
    'xref\n0 3\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const date = '2026-10-19T05:06:07.000Z';
describe('new branded PDF Info metadata', () => {
  it('preserves original PDF bytes and writes correct classic-xref/root/previous offsets', () => {
    const before = pdf(),
      result = addBrandedPdfMetadata(before, 'Human-reviewed report', date);
    expect(result.subarray(0, before.length).equals(before)).toBe(true);
    const raw = result.toString('latin1');
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(raw)?.[1]);
    expect(raw.slice(xref, xref + 8)).toBe('xref\n3 1');
    const object = Number(raw.slice(xref).match(/xref\n3 1\n(\d{10})/)?.[1]);
    expect(raw.slice(object, object + 7)).toBe('3 0 obj');
    expect(raw).toContain('/Root 1 0 R');
    expect(raw).toContain('/Info 3 0 R /Prev ');
    expect(raw).toContain("/CreationDate (D:20261019050607+00'00')");
    expect(addBrandedPdfMetadata(before, 'Human-reviewed report', date).equals(result)).toBe(true);
  });
  it('writes Unicode and hostile title characters only as UTF16BE hex data', () => {
    const title = 'भारत <report> ) /Root 99 0 R';
    const result = addBrandedPdfMetadata(pdf(), title, date).toString('latin1');
    const titleHex = /\/Title <FEFF([a-f0-9]+)>/.exec(result)?.[1];
    expect(titleHex).toBeDefined();
    expect(Buffer.from(titleHex!, 'hex').swap16().toString('utf16le')).toBe(title);
    expect(result.includes('/Root 99 0 R')).toBe(false);
    expect(result).toContain(
      Buffer.from('Axiom Minds Private Limited', 'utf16le').swap16().toString('hex'),
    );
  });
  it.each([
    (s: string) => s.replace('/Root 1 0 R', '/Else 1 0 R'),
    (s: string) => s.replace('/Size 3', '/Size 0'),
    (s: string) => s.replace('/Size 3', '/Size 1000001'),
    (s: string) => s.replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 2 0 R'),
    (s: string) => s.replace('/Root 1 0 R', '/Root 1 0 R /Prev 10'),
    (s: string) => s.replace(/startxref\n\d+/, 'startxref\n999999'),
    (s: string) => s.replace('xref\n0 3', 'xxxx\n0 3'),
    (s: string) => s.replace('%%EOF', 'missing'),
  ])('refuses unsupported/malformed trailer without editing input', (mutate) => {
    const before = Buffer.from(mutate(pdf().toString()));
    const copy = Buffer.from(before);
    expect(() => addBrandedPdfMetadata(before, 'Report', date)).toThrow(
      'branded_pdf_metadata_refused',
    );
    expect(before.equals(copy)).toBe(true);
  });
  it('refuses oversized PDFs, invalid dates and control characters', () => {
    expect(() =>
      addBrandedPdfMetadata(Buffer.alloc(32 * 1024 * 1024 + 1), 'Report', date),
    ).toThrow();
    expect(() => addBrandedPdfMetadata(pdf(), 'Report', 'invalid')).toThrow();
    expect(() => addBrandedPdfMetadata(pdf(), 'Report\u0000Injected', date)).toThrow();
  });
});
