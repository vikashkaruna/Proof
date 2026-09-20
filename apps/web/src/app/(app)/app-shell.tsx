'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AxiomLogo } from '@axiom/ui';
import { SidebarAgentPanel } from './sidebar-agent-panel';
import { APP_NAV_GROUPS, visibleNavGroups, type NavGroup, type NavItem } from './nav';
import { switchTenantAction } from './tenant-actions';

export { APP_NAV_GROUPS };
export type { NavGroup, NavItem };

/**
 * A tenant the signed-in user actually belongs to.
 *
 * What stood here was `DEFAULT_TENANTS` — three invented companies ("Meridian
 * Pay · Fintech · 420 employees · score 74") rendered to every user under the
 * heading "Demo environments", and used as the FIRST source when resolving the
 * active tenant from the cookie, ahead of real memberships. A client opening
 * the switcher saw two other companies' names beside their own.
 *
 * The fields are now only those we actually know from `tenant_users`. `mark`
 * and `color` are derived from the name and id: presentation, not data.
 */
export interface TenantOption {
  id: string;
  name: string;
  slug: string;
  role: string;
}

const TENANT_COLORS = ['#1E2A4A', '#0FB5A5', '#C9A227', '#5B6BA8', '#7A5C9E', '#3F7D6B'];

/** Stable per tenant, so the same client keeps the same chip between visits. */
function tenantColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TENANT_COLORS[hash % TENANT_COLORS.length]!;
}

function tenantMark(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface AppShellProps {
  children: React.ReactNode;
  user: {
    id: string;
    email?: string;
    user_metadata?: { full_name?: string };
  };
  tenants: TenantOption[];
  activeTenantSlug?: string;
  /**
   * The persona's capabilities, resolved on the server from the central
   * matrix. Passed in rather than derived here so there is one place that
   * decides — the same module the BFF enforces with.
   */
  capabilities: readonly string[];
  logoutAction: () => Promise<void>;
}

export function AppShell({
  children,
  user,
  tenants,
  activeTenantSlug,
  capabilities,
  logoutAction,
}: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [killOn, setKillOn] = useState(false);
  const [tenantsOpen, setTenantsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const held = new Set(capabilities);
  const navGroups = visibleNavGroups(capabilities);

  // Halting a client's automation is an authority, not a convenience. A viewer
  // was previously shown this button; the BFF refused, so all it taught them
  // was that the product is broken.
  const canKillSwitch = held.has('kill_switch.engage.tenant');

  // Resolved from memberships alone. A slug the user does not belong to is
  // ignored rather than honoured — the same rule `requireTenantContext()`
  // applies on the server, and the reason the cookie is a preference.
  const preferred = activeTenantSlug
    ? tenants.find((t) => t.slug === activeTenantSlug || t.id === activeTenantSlug)
    : undefined;
  const selectedTenant: TenantOption | null = preferred ?? tenants[0] ?? null;

  const selectedTenantId = selectedTenant?.id ?? null;

  useEffect(() => {
    let active = true;
    async function fetchKillStatus() {
      if (!selectedTenantId) return;
      try {
        // Reading whether execution is halted is not an authority — a viewer
        // who cannot engage the switch should still be told when the platform
        // has stopped acting on their estate. Only the toggle is gated.
        const res = await fetch('/api/bff/v1/kill-switch/status', {
          headers: { 'X-Tenant-Id': selectedTenantId },
        });
        if (res.ok) {
          const data = await res.json();
          if (active && typeof data.engaged === 'boolean') {
            setKillOn(data.engaged);
          }
        }
      } catch {
        // Fallback
      }
    }
    fetchKillStatus();

    const handleEvent = (e: Event) => {
      const custom = e as CustomEvent<{ engaged: boolean }>;
      if (typeof custom.detail?.engaged === 'boolean') {
        setKillOn(custom.detail.engaged);
      }
    };
    window.addEventListener('axiom:kill-switch-changed', handleEvent);
    return () => {
      active = false;
      window.removeEventListener('axiom:kill-switch-changed', handleEvent);
    };
  }, [selectedTenantId]);

  async function handleToggleKillSwitch() {
    if (!selectedTenantId || !canKillSwitch) return;
    if (!killOn) {
      if (
        !confirm('ENGAGE KILL SWITCH?\n\nThis halts all in-flight agent execution for this tenant.')
      )
        return;
      try {
        const res = await fetch('/api/bff/v1/kill-switch/engage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': selectedTenantId },
          body: JSON.stringify({ scope: 'tenant', reason: 'Engaged from navigation bar' }),
        });
        if (res.ok) {
          setKillOn(true);
          window.dispatchEvent(
            new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }),
          );
        }
      } catch (err) {
        console.error('Failed to engage kill switch:', err);
      }
    } else {
      if (!confirm('DISENGAGE KILL SWITCH?\n\nThis will resume autonomous agent executions.'))
        return;
      try {
        const res = await fetch('/api/bff/v1/kill-switch/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': selectedTenantId },
        });
        if (res.ok) {
          setKillOn(false);
          window.dispatchEvent(
            new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: false } }),
          );
        }
      } catch (err) {
        console.error('Failed to release kill switch:', err);
      }
    }
  }

  const handleSelectTenant = async (t: TenantOption) => {
    setTenantsOpen(false);
    if (t.id === selectedTenantId) return;
    setSwitching(true);
    try {
      // The server sets the cookie, after verifying the membership. Optimistic
      // local state is deliberately not used: the active tenant determines what
      // every server component renders, so the browser showing one tenant while
      // the server renders another is the worst possible failure here.
      const result = await switchTenantAction(t.slug || t.id);
      if (!result.ok) return;
      const targetSlug = t.slug || t.id;
      if (pathname === '/portal') {
        router.push(`/portal?tenant=${targetSlug}`);
      } else {
        router.refresh();
      }
    } finally {
      setSwitching(false);
    }
  };

  // Find active group and item for breadcrumb
  let activeBreadcrumb = 'Overview';
  let activeTitle = 'Dashboard';

  for (const group of navGroups) {
    for (const item of group.items) {
      if (
        pathname === item.route ||
        (item.route !== '/dashboard' && pathname.startsWith(item.route))
      ) {
        activeBreadcrumb = group.label;
        activeTitle = item.en;
        break;
      }
    }
  }

  return (
    <div className="flex min-h-screen bg-[#F4F6F8]">
      {/* ============ SIDEBAR ============ */}
      <aside className="sticky top-0 z-30 flex h-screen w-[266px] shrink-0 flex-col bg-[#1E2A4A] text-[#c7cfe0] border-r border-white/10">
        {/* Brand Header */}
        <div className="flex h-16 shrink-0 items-center px-5 border-b border-white/10">
          <Link href="/dashboard" className="flex items-center gap-3">
            <AxiomLogo size="md" theme="dark" showSubtitle={true} />
          </Link>
        </div>

        {/* Navigation Stream */}
        <div className="flex-1 overflow-y-auto py-2">
          {navGroups.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-5 pt-3.5 pb-1 text-[9.5px] font-semibold tracking-[0.08em] uppercase text-[#6f7ba0]">
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive =
                  pathname === item.route ||
                  (item.route !== '/dashboard' && pathname.startsWith(item.route));

                return (
                  <Link
                    key={item.route}
                    href={item.route}
                    className={`flex items-center gap-2.5 px-5 py-1.5 transition-colors ${
                      isActive
                        ? 'border-l-[3px] border-[#0FB5A5] bg-[#0FB5A5]/10 text-white font-semibold'
                        : 'border-l-[3px] border-transparent text-[#c7cfe0] hover:bg-white/5'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        isActive ? 'bg-[#0FB5A5]' : 'bg-[#3d4863]'
                      }`}
                    />
                    <span className="flex flex-1 items-center gap-1.5 text-[13px] truncate">
                      <span className={isActive ? 'text-white' : 'text-[#c7cfe0]'}>{item.en}</span>
                      <span className="font-heading text-[10.5px] text-[#6f7ba0] font-normal">
                        {item.hi}
                      </span>
                    </span>
                    {item.star && <span className="text-[#C9A227] text-xs">★</span>}
                    <span
                      className={`text-[8.5px] font-semibold tracking-wider px-1.5 py-0.5 rounded ${
                        isActive ? 'bg-white/20 text-white' : 'bg-white/5 text-[#8a97b8]'
                      }`}
                    >
                      {item.phase}
                    </span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* User Profile Bar */}
        <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3 bg-[#182238]/60">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#C9A227] font-heading text-xs font-bold text-[#1E2A4A]">
            {(user.user_metadata?.full_name ?? user.email ?? 'P')[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-white">
              {user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Priya Nair'}
            </div>
            <div className="text-[10px] text-[#6f7ba0]">Compliance Head · Approver</div>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              title="Sign out"
              className="text-[11px] text-[#8a909b] hover:text-white transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>

        {/* Bespoke 10-Agent Panel (Preserved!) */}
        <SidebarAgentPanel />
      </aside>

      {/* ============ MAIN AREA ============ */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex h-[60px] shrink-0 items-center gap-4 border-b border-[#e4e8ee] bg-white px-6">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-[#8a909b] truncate">{activeBreadcrumb}</div>
            <h1 className="font-heading text-[17px] font-semibold leading-tight text-[#1E2A4A] truncate">
              {activeTitle}
            </h1>
          </div>

          {/* Tenant Switcher */}
          <div className="relative">
            <div
              onClick={() => setTenantsOpen(!tenantsOpen)}
              className="flex items-center gap-2.5 rounded-lg border border-[#e4e8ee] bg-white px-3 py-1.5 cursor-pointer shadow-sm hover:border-[#0FB5A5] transition-colors"
            >
              <span
                style={{
                  backgroundColor: selectedTenant ? tenantColor(selectedTenant.id) : '#8a909b',
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md font-heading text-[11px] font-bold text-white"
              >
                {selectedTenant ? tenantMark(selectedTenant.name) : '—'}
              </span>
              <div className="leading-tight text-left">
                <div className="text-xs font-semibold text-[#2F3542]">
                  {selectedTenant?.name ?? 'No organization'}
                </div>
                {/* The role, which is a fact. What stood here was an invented
                    sector ("Enterprise") shown as if it were tenant data. */}
                <div className="text-[10px] text-[#8a909b]">
                  {selectedTenant?.role ?? 'no membership'}
                </div>
              </div>
              <span className="text-[10px] text-[#8a909b] ml-1">▾</span>
            </div>

            {tenantsOpen && (
              <div className="absolute right-0 top-12 z-50 w-72 rounded-xl border border-[#e4e8ee] bg-white p-1.5 shadow-xl max-h-[420px] overflow-y-auto">
                {/* Only memberships. The "Demo environments" section that stood
                    here listed three invented companies to every user, and was
                    consulted BEFORE real memberships when resolving the active
                    tenant from the cookie. */}
                {tenants.length > 0 ? (
                  <div className="mb-2">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#0FB5A5]">
                      Your organizations
                    </div>
                    {tenants.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => void handleSelectTenant(t)}
                        aria-disabled={switching}
                        className={`flex items-center gap-2.5 rounded-lg p-2 transition-colors ${
                          switching ? 'cursor-wait opacity-60' : 'cursor-pointer'
                        } ${t.id === selectedTenantId ? 'bg-[#F4F6F8]' : 'hover:bg-[#F4F6F8]'}`}
                      >
                        <span
                          style={{ backgroundColor: tenantColor(t.id) }}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-heading text-xs font-bold text-white"
                        >
                          {tenantMark(t.name)}
                        </span>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-xs font-semibold text-[#2F3542] truncate">
                            {t.name}
                          </div>
                          <div className="text-[10.5px] text-[#8a909b] truncate">{t.role}</div>
                        </div>
                        {t.id === selectedTenantId && (
                          <span className="text-xs font-bold font-mono text-[#0FB5A5]">Active</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-[11px] text-[#8a909b]">
                    You are not a member of any organization yet.
                  </div>
                )}

                <div className="mt-1 border-t border-[#eef1f5] pt-1">
                  <Link
                    href="/onboarding"
                    onClick={() => setTenantsOpen(false)}
                    className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-700 hover:bg-teal-100 transition-colors"
                  >
                    <span>+ Onboard New Organization</span>
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* The "Environment Indicator" that stood here read
              `selectedTenant.env` — a hardcoded 'Production' on every invented
              tenant, and an outright lie on a staging deployment. Deployment
              environment is not a property of a tenant, and a badge nobody
              computed is worse than no badge. */}

          {/* Kill Switch Toggle — only for a persona that may engage it. */}
          {canKillSwitch && (
            <button
              onClick={handleToggleKillSwitch}
              disabled={!selectedTenantId}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                killOn
                  ? 'border-[#D9534F] bg-[#D9534F] text-white shadow-sm animate-pulse'
                  : 'border-[#e4e8ee] bg-white text-[#D9534F] hover:bg-[#FCEEEC]'
              }`}
              title="Halt autonomous agent execution for this tenant"
            >
              <span>⏻</span> {killOn ? 'Kill switch active' : 'Kill switch'}
            </button>
          )}
        </header>

        {/* Global Kill Switch Alert Banner */}
        {killOn && (
          <div className="flex items-center justify-between bg-[#D9534F] px-6 py-2.5 text-xs font-semibold text-white shadow-inner">
            <div className="flex items-center gap-2">
              <span className="text-sm">⏻</span>
              <span>KILL SWITCH ENGAGED — in-flight agent execution is halted.</span>
            </div>
            {canKillSwitch && (
              <button
                onClick={handleToggleKillSwitch}
                className="font-normal underline hover:text-white/80 cursor-pointer"
              >
                Disengage
              </button>
            )}
          </div>
        )}

        {/* Main Content Viewport */}
        <main className="flex-1 overflow-y-auto px-8 py-7">{children}</main>
      </div>
    </div>
  );
}
