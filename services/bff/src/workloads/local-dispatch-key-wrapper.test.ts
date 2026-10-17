import { describe, expect, it, vi } from 'vitest';

const requestLocalKeyMtls = vi.hoisted(() => vi.fn());
const binding = vi.hoisted(() => ({ ok: true }));
vi.mock('./local-key-mtls.js', async (original) => ({
  ...(await original<typeof import('./local-key-mtls.js')>()),
  requestLocalKeyMtls,
}));
vi.mock('./dispatch-key-policy.js', async (original) => ({
  ...(await original<typeof import('./dispatch-key-policy.js')>()),
  dispatchKmsBinding: () => {
    if (!binding.ok) throw new Error('binding');
    return { tenant: id(1), aad: Buffer.alloc(1) };
  },
}));
const { LocalDispatchKeyWrapper } = await import('./local-dispatch-key-wrapper.js');

const id = (n: number) => `67670000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyRef = `axiom-local-dispatch://${id(1)}/${id(10)}/versions/1`;
const jobId = id(3);
const tenantId = id(1);

describe('local dispatch key wrapper', () => {
  const ctx = Buffer.from(JSON.stringify(['v1', jobId, tenantId]));
  const wrapper = () =>
    new LocalDispatchKeyWrapper({
      source: {} as never,
      identities: {} as never,
      serverIdentity: 'spiffe://local.axiomproof.test/service/local-key',
      endpoint: { path: '/run/axiom-key/key.sock' },
    });

  it('wraps through one exact-identity mTLS exchange and returns the service key ref', async () => {
    requestLocalKeyMtls.mockResolvedValueOnce({
      version: 1,
      keyRef,
      key: Buffer.alloc(61, 7).toString('base64'),
    });
    const out = await wrapper().wrap(ctx, Buffer.alloc(32, 1));
    expect(out.keyRef).toBe(keyRef);
    expect(out.wrappedKey.length).toBe(61);
    const call = requestLocalKeyMtls.mock.calls.at(-1)![0];
    expect(call.serverIdentity).toBe('spiffe://local.axiomproof.test/service/local-key');
    expect(call.request).toEqual({
      version: 1,
      operation: 'wrap',
      context: ctx.toString('base64'),
      key: Buffer.alloc(32, 1).toString('base64'),
    });
  });

  it('unwraps with the stored key ref and refuses malformed service replies', async () => {
    requestLocalKeyMtls.mockResolvedValueOnce({
      version: 1,
      key: Buffer.alloc(32, 9).toString('base64'),
    });
    expect((await wrapper().unwrap(ctx, keyRef, Buffer.alloc(61))).length).toBe(32);
    expect(requestLocalKeyMtls.mock.calls.at(-1)![0].request).toMatchObject({
      operation: 'unwrap',
      keyRef,
    });
    requestLocalKeyMtls.mockResolvedValueOnce({
      version: 1,
      keyRef,
      key: Buffer.alloc(32).toString('base64'),
    });
    await expect(wrapper().unwrap(ctx, keyRef, Buffer.alloc(61))).rejects.toThrow();
    requestLocalKeyMtls.mockResolvedValueOnce({
      version: 1,
      keyRef,
      key: Buffer.alloc(60).toString('base64'),
    });
    await expect(wrapper().wrap(ctx, Buffer.alloc(32))).rejects.toThrow();
  });

  it('refuses bad inputs before any network exchange', async () => {
    const before = requestLocalKeyMtls.mock.calls.length;
    await expect(wrapper().wrap(ctx, Buffer.alloc(31))).rejects.toThrow();
    await expect(wrapper().unwrap(ctx, 'not-a-ref', Buffer.alloc(61))).rejects.toThrow();
    await expect(wrapper().unwrap(ctx, keyRef, Buffer.alloc(60))).rejects.toThrow();
    binding.ok = false;
    await expect(wrapper().wrap(ctx, Buffer.alloc(32))).rejects.toThrow();
    binding.ok = true;
    expect(requestLocalKeyMtls.mock.calls.length).toBe(before);
  });

  it('allows only one outstanding exchange per adapter', async () => {
    let release: (v: unknown) => void = () => {};
    requestLocalKeyMtls.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const w = wrapper();
    const first = w.wrap(ctx, Buffer.alloc(32));
    await expect(w.wrap(ctx, Buffer.alloc(32))).rejects.toThrow();
    release({ version: 1, keyRef, key: Buffer.alloc(61).toString('base64') });
    await expect(first).resolves.toMatchObject({ keyRef });
  });
});
