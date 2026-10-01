import { afterEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ rpc: vi.fn() })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@axiom/config', () => ({
  loadEnv: () => ({
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_KEY: 'generic-key',
  }),
}));

import { createApprovalArchiveWriter } from './approval-archive-writer.js';

const key = (role: string, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `header.${Buffer.from(JSON.stringify({ role, exp })).toString('base64url')}.signature`;

afterEach(() => {
  delete process.env.SUPABASE_ARCHIVE_WRITER_KEY;
  createClient.mockClear();
});

describe('BFF-only approval archive credential', () => {
  it('fails closed for missing, generic, expired and wrong-role keys', () => {
    expect(() => createApprovalArchiveWriter()).toThrow(/credential is required/);
    process.env.SUPABASE_ARCHIVE_WRITER_KEY = 'generic-key';
    expect(() => createApprovalArchiveWriter()).toThrow(/credential is required/);
    process.env.SUPABASE_ARCHIVE_WRITER_KEY = key('service_role');
    expect(() => createApprovalArchiveWriter()).toThrow(/invalid role or expiry/);
    process.env.SUPABASE_ARCHIVE_WRITER_KEY = key('approval_archive_writer', 1);
    expect(() => createApprovalArchiveWriter()).toThrow(/invalid role or expiry/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('uses only the distinct archive writer JWT for the dedicated client', () => {
    const writer = key('approval_archive_writer');
    process.env.SUPABASE_ARCHIVE_WRITER_KEY = writer;
    createApprovalArchiveWriter();
    expect(createClient).toHaveBeenCalledWith(
      'http://localhost:54321',
      'anon-key',
      expect.objectContaining({
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${writer}` } },
      }),
    );
  });
});
