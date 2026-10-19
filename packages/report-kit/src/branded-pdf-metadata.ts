/** Append an ordinary PDF Info revision only to newly generated branded PDFs.
 * Never apply to retained/signed/provider bytes or any legacy renderer. */
export function addBrandedPdfMetadata(bytes: Buffer, title: string, documentDate: string): Buffer {
  if (
    bytes.length > 32 * 1024 * 1024 ||
    bytes.subarray(0, 5).toString() !== '%PDF-' ||
    !title ||
    title.length > 300 ||
    /\u0000/.test(title)
  )
    throw Error('branded_pdf_metadata_refused');
  const date = new Date(documentDate);
  if (!Number.isFinite(date.getTime())) throw Error('branded_pdf_metadata_refused');
  const raw = bytes.toString('latin1');
  const tail = /trailer\s*(<<(?:(?!trailer)[\s\S])*?>>)\s*startxref\s*(\d+)\s*%%EOF\s*$/.exec(raw);
  if (
    !tail ||
    /\/(?:Encrypt|Prev|XRefStm)\b/.test(tail[1]!) ||
    !/\/Root\s+\d+\s+\d+\s+R\b/.test(tail[1]!)
  )
    throw Error('branded_pdf_metadata_refused');
  const count = /\/Size\s+(\d+)\b/.exec(tail[1]!);
  const id = Number(count?.[1]);
  const previous = Number(tail[2]);
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    id > 1_000_000 ||
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous >= bytes.length ||
    raw.slice(previous, previous + 4) !== 'xref'
  )
    throw Error('branded_pdf_metadata_refused');
  // UTF-16BE hexadecimal strings cannot inject PDF operators or references.
  const text = (value: string) => `<FEFF${Buffer.from(value, 'utf16le').swap16().toString('hex')}>`;
  const when = `D:${date.toISOString().slice(0, 19).replace(/[-:T]/g, '')}+00'00'`;
  const info = `\n${id} 0 obj\n<< /Title ${text(title)} /Author ${text('Axiom Minds Private Limited')} /Creator ${text('Axiom Proof | axiomproof.ai')} /Subject ${text('Source-bound working report; review, artifact custody and release are separate.')} /Keywords ${text('axiom-report-brand-1')} /CreationDate (${when}) /ModDate (${when}) >>\nendobj\n`;
  const offset = bytes.length + 1;
  let trailer = tail[1]!
    .replace(/\/Size\s+\d+\b/, `/Size ${id + 1}`)
    .replace(/\/Info\s+\d+\s+\d+\s+R\b/g, '');
  trailer = trailer.slice(0, -2) + ` /Info ${id} 0 R /Prev ${previous} >>`;
  const xref = bytes.length + Buffer.byteLength(info, 'latin1');
  return Buffer.concat([
    bytes,
    Buffer.from(
      `${info}xref\n${id} 1\n${String(offset).padStart(10, '0')} 00000 n \ntrailer\n${trailer}\nstartxref\n${xref}\n%%EOF\n`,
      'latin1',
    ),
  ]);
}
