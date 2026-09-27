import { describe, expect, it, vi } from 'vitest';
import {
  evidenceUploadBytes,
  verifyLocalFile,
  MAX_EVIDENCE_UPLOAD_BYTES,
  MAX_LOCAL_VERIFY_BYTES,
} from './evidence-workflow';

const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
describe('independent evidence integrity', () => {
  it('hashes actual bytes against a known independent SHA-256 vector without network calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await verifyLocalFile(new File(['abc'], 'fixture.txt'), abc, 3);
    expect(result).toEqual({
      computedHash: abc,
      hashMatches: true,
      byteSize: 3,
      sizeMatches: true,
    });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it('detects a one-byte change, independently of a plausible recorded size', async () => {
    const result = await verifyLocalFile(new File(['abd'], 'fixture.txt'), abc, 3);
    expect(result.hashMatches).toBe(false);
    expect(result.sizeMatches).toBe(true);
  });
  it('does not hide an inconsistent or missing size behind a matching hash', async () => {
    expect((await verifyLocalFile(new File(['abc'], 'fixture.txt'), abc, 4)).sizeMatches).toBe(
      false,
    );
    expect(
      (await verifyLocalFile(new File(['abc'], 'fixture.txt'), abc, null)).sizeMatches,
    ).toBeNull();
  });
  it('rejects a malformed recorded digest', async () => {
    await expect(
      verifyLocalFile(new File(['abc'], 'fixture.txt'), 'not-a-seal', 3),
    ).rejects.toThrow('recorded SHA-256');
  });
  it('rejects oversized local comparison before reading bytes or making any request', async () => {
    const file = new File(['abc'], 'large.bin');
    Object.defineProperty(file, 'size', { value: MAX_LOCAL_VERIFY_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(verifyLocalFile(file, abc, file.size)).rejects.toThrow('32 MiB');
      expect(read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('encodes exact binary bytes for an explicitly requested upload', async () => {
    const input = Uint8Array.from([0, 255, 10, 128]);
    const result = await evidenceUploadBytes(new File([input], 'fixture.bin'));
    expect(Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0))).toEqual([...input]);
  });
  it('refuses empty and oversized upload files before reading', async () => {
    await expect(evidenceUploadBytes(new File([], 'empty'))).rejects.toThrow('non-empty');
    const file = new File(['a'], 'large');
    Object.defineProperty(file, 'size', { value: MAX_EVIDENCE_UPLOAD_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(evidenceUploadBytes(file)).rejects.toThrow('8 MiB');
    expect(read).not.toHaveBeenCalled();
  });
});
