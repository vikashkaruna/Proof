import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { Capability, UserRole } from '@axiom/types';
import { requireCapability } from './authorize.js';
import type { Variables } from '../types.js';

/**
 * W9 · W1 · SEC-9 — the BFF is the authoritative authorisation gate.
 *
 * The web app's render gating is a usability nicety. These tests assert the
 * boundary that actually holds: a caller who reaches the endpoint directly,
 * with a valid session for the right tenant but the wrong role, is refused.
 */

function buildApp(ctx: { role: string; approvalScopes?: readonly string[] }) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user-a' } as never);
    c.set('tenantId', 'tenant-a' as never);
    c.set('role', ctx.role as never);
    c.set('approvalScopes', (ctx.approvalScopes ?? []) as never);
    await next();
  });
  app.post('/approve', (c) => {
    const refusal = requireCapability(c, Capability.PLAN_APPROVE, {
      approvalScopes: c.get('approvalScopes'),
      actionClass: c.req.query('actionClass'),
    });
    if (refusal) return refusal;
    return c.json({ approved: true });
  });
  app.post('/kill-switch/global', (c) => {
    const refusal = requireCapability(c, Capability.KILL_SWITCH_ENGAGE_GLOBAL);
    if (refusal) return refusal;
    return c.json({ engaged: true });
  });
  return app;
}

describe('requireCapability — role gate', () => {
  it.each([UserRole.FOUNDER, UserRole.OWNER, UserRole.ADMIN, UserRole.APPROVER])(
    'permits %s to approve',
    async (role) => {
      const res = await buildApp({ role }).request('/approve', { method: 'POST' });
      expect(res.status).toBe(200);
    },
  );

  it.each([UserRole.VIEWER, UserRole.REVIEWER, UserRole.PARTNER, UserRole.AGENT])(
    'refuses %s with 403',
    async (role) => {
      const res = await buildApp({ role }).request('/approve', { method: 'POST' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('role_forbidden');
    },
  );

  // SEC-4: `owner` is a per-tenant role and is not authority over every
  // tenant's execution.
  it('refuses a tenant owner the global kill switch', async () => {
    const res = await buildApp({ role: UserRole.OWNER }).request('/kill-switch/global', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('permits the founder the global kill switch', async () => {
    const res = await buildApp({ role: UserRole.FOUNDER }).request('/kill-switch/global', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });
});

describe('requireCapability — approval_scopes', () => {
  it('permits an unscoped approver', async () => {
    const res = await buildApp({ role: UserRole.APPROVER }).request('/approve', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('permits a scoped approver within scope', async () => {
    const app = buildApp({ role: UserRole.APPROVER, approvalScopes: ['data-deletion'] });
    const res = await app.request('/approve?actionClass=data-deletion', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('refuses a scoped approver outside scope, distinctly from a role refusal', async () => {
    const app = buildApp({ role: UserRole.APPROVER, approvalScopes: ['data-deletion'] });
    const res = await app.request('/approve?actionClass=cross-border-transfer', { method: 'POST' });
    expect(res.status).toBe(403);
    // The distinction matters: "not you" and "not this action class" are
    // different things to tell a user.
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('scope_forbidden');
  });

  it('does not let a scope widen a role', async () => {
    const app = buildApp({ role: UserRole.VIEWER, approvalScopes: ['data-deletion'] });
    const res = await app.request('/approve?actionClass=data-deletion', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('role_forbidden');
  });
});
