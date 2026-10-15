import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mappingContextSourcePacket } from '@axiom/control-library';
import type { Variables } from '../types.js';
const port = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => ({ rpc: port.rpc }) }));
import { catalogueReferenceRoutes } from './catalogue-references.js';
const packet = mappingContextSourcePacket();
function proof(text = JSON.stringify(packet)) {
  return {
    publicationVersion: packet.publicationVersion,
    libraryVersion: packet.libraryVersion,
    contextCount: packet.contexts.length,
    packetText: text,
    packetSha256: createHash('sha256').update(text).digest('hex'),
  };
}
function app(role: Variables['role'] = 'viewer') {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('role', role);
    c.set('user', { id: '10000000-0000-4000-8000-000000000001' } as Variables['user']);
    return next();
  });
  app.route('/v1', catalogueReferenceRoutes());
  return app;
}
const path = '/v1/control-catalogue/publications/' + packet.publicationVersion;
beforeEach(() => {
  port.rpc.mockReset().mockReturnValue({ abortSignal: port.abort });
  port.abort.mockReset().mockResolvedValue({ data: proof(), error: null });
});
describe('retained catalogue reference read', () => {
  it.each(['viewer', 'owner', 'founder', 'axiom_analyst'] as const)(
    'returns exact verified reference bytes for %s without a mutation',
    async (role) => {
      const response = await app(role).request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ data: proof(), referenceOnly: true });
      expect(port.rpc).toHaveBeenCalledExactlyOnceWith('read_mapping_context_publication', {
        p_publication_version: packet.publicationVersion,
      });
      expect(port.abort).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    },
  );
  it.each([
    'wrong-version',
    'wrong-library',
    'wrong-count',
    'wrong-hash',
    'extra-provenance',
    'invalid-json',
    'duplicate-key',
    'duplicate-escaped-key',
  ])('refuses divergent or ambiguous retained reference: %s', async (fault) => {
    const value = proof();
    if (fault === 'wrong-version') value.publicationVersion = 'other-version';
    if (fault === 'wrong-library') value.libraryVersion = 'other-library';
    if (fault === 'wrong-count') value.contextCount += 1;
    if (fault === 'wrong-hash') value.packetSha256 = 'f'.repeat(64);
    if (fault === 'extra-provenance') Object.assign(value, { publisherId: 'private-actor' });
    if (fault === 'invalid-json') value.packetText = '{';
    if (fault.startsWith('duplicate')) {
      const key = fault === 'duplicate-key' ? 'publicationVersion' : 'publication\\u0056ersion';
      value.packetText = '{"' + key + '":"different",' + value.packetText.slice(1);
      value.packetSha256 = createHash('sha256').update(value.packetText).digest('hex');
    }
    port.abort.mockResolvedValue({ data: value, error: null });
    const response = await app().request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'catalogue_unavailable' } });
  });
  it('refuses malformed versions and roles before database IO', async () => {
    expect((await app().request('/v1/control-catalogue/publications/UPPER')).status).toBe(400);
    expect((await app('unknown' as Variables['role']).request(path)).status).toBe(403);
    expect(port.rpc).not.toHaveBeenCalled();
  });
  it('reports an absent retained publication without manufacturing seed data', async () => {
    port.abort.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'catalogue context unavailable' },
    });
    const response = await app().request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'catalogue_not_found' } });
  });
  it.each(['returned', 'thrown', 'null'])('fails closed on %s database failure', async (kind) => {
    if (kind === 'returned')
      port.abort.mockResolvedValue({
        data: proof(),
        error: { code: 'network', message: 'synthetic-private-vendor-message' },
      });
    if (kind === 'thrown')
      port.abort.mockRejectedValue(new Error('synthetic-private-vendor-message'));
    if (kind === 'null') port.abort.mockResolvedValue({ data: null, error: null });
    const response = await app().request(path);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('synthetic-private-vendor-message');
  });
  it('exposes no publication or adoption mutation', async () => {
    expect((await app('founder').request(path, { method: 'POST' })).status).toBe(404);
    expect(port.rpc).not.toHaveBeenCalled();
  });
});
