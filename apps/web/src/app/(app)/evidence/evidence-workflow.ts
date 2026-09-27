/** Read-only independent integrity check. This function never uploads the selected file. */
export const MAX_LOCAL_VERIFY_BYTES = 32 * 1024 * 1024;
export const MAX_EVIDENCE_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function verifyLocalFile(
  file: File,
  recordedHash: string,
  recordedSize: number | null,
) {
  if (!/^[a-f0-9]{64}$/i.test(recordedHash))
    throw new Error('A valid recorded SHA-256 is unavailable.');
  if (file.size > MAX_LOCAL_VERIFY_BYTES)
    throw new Error('Select a file of at most 32 MiB for browser verification.');
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const computedHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return {
    computedHash,
    hashMatches: computedHash === recordedHash.toLowerCase(),
    byteSize: bytes.byteLength,
    sizeMatches: recordedSize === null ? null : recordedSize === bytes.byteLength,
  };
}

export async function evidenceUploadBytes(file: File) {
  if (file.size < 1 || file.size > MAX_EVIDENCE_UPLOAD_BYTES)
    throw new Error('Select a non-empty file of at most 8 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return {
    contentBase64: btoa(binary),
    fingerprint: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}
