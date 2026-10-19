/** PDF text extraction inserts layout whitespace; preserve every nonspace byte. */
export function normalizePdfText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
