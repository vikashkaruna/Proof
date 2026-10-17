'use client';

import { formatTime } from '@/lib/display-time';
import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AxiomLogo } from '@axiom/ui';
import { SidebarAgentPanel } from './sidebar-agent-panel';
import { APP_NAV_GROUPS, visibleNavGroups, type NavGroup, type NavItem } from './nav';
import { switchTenantAction } from './tenant-actions';
import { z } from 'zod';

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

const TENANT_COLORS = ['#1E2A4A', '#0FB5A5', '#475569', '#5B6BA8', '#7A5C9E', '#3F7D6B'];
const alertReadSchema = z.object({
  data: z.object({
    summary: z.object({
      unread: z.number().int().nonnegative(),
      critical: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
    }),
    alerts: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        summary: z.string(),
        severity: z.string(),
        status: z.string(),
        alert_type: z.string(),
        created_at: z.string().datetime({ offset: true }),
      }),
    ),
  }),
});

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
  canViewClosureDossiers?: boolean;
  logoutAction: () => Promise<void>;
}

export function AppShell({
  children,
  user,
  tenants,
  activeTenantSlug,
  capabilities,
  canViewClosureDossiers = false,
  logoutAction,
}: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams?.get('tab');

  const isItemActive = (itemRoute: string): boolean => {
    if (itemRoute.includes('?')) {
      const [itemPath, itemQuery] = itemRoute.split('?');
      const params = new URLSearchParams(itemQuery);
      return pathname === itemPath && currentTab === params.get('tab');
    }
    if (itemRoute === '/reports') {
      return pathname === '/reports' && (currentTab !== 'pramaan' || !canViewClosureDossiers);
    }
    return pathname === itemRoute || (itemRoute !== '/dashboard' && pathname.startsWith(itemRoute));
  };
  const [killState, setKillState] = useState<{ tenantId: string; engaged: boolean } | null>(null);
  const [killError, setKillError] = useState<string | null>(null);
  const [tenantsOpen, setTenantsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsSummary, setAlertsSummary] = useState<{
    tenantId: string;
    unread: number;
    critical: number;
    high: number;
    alerts: Array<{
      id: string;
      title: string;
      summary: string;
      severity: string;
      alert_type: string;
      created_at: string;
    }>;
  } | null>(null);
  const mobileNav = useRef<HTMLDialogElement>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const closeOnWide = () => {
      if (wide.matches) mobileNav.current?.close();
    };
    wide.addEventListener('change', closeOnWide);
    return () => wide.removeEventListener('change', closeOnWide);
  }, []);
  useEffect(() => {
    mobileNav.current?.close();
  }, [pathname]);

  const held = new Set(capabilities);
  const navGroups = visibleNavGroups(capabilities, APP_NAV_GROUPS, canViewClosureDossiers);

  // Halting a client's automation is an authority, not a convenience. A viewer
  // was previously shown this button; the BFF refused, so all it taught them
  // was that the product is broken.
  const canKillSwitch = held.has('kill_switch.engage.tenant');
  // Releasing is a separate, narrower authority (owner, founder). Offering the
  // release to a role that can only engage produced a link that did nothing.
  const canReleaseKill = held.has('kill_switch.release.tenant');
  // Creating another organisation is a commercial act (tenant.create): the
  // founder's and an owner's, not something to advertise to every reader.
  const canCreateTenant = held.has('tenant.create');
  // The agent panel's actions open agent workflows; a pure reader has no use
  // for a launcher whose every action they would be refused.
  const canSeeAgents = held.has('agent.invoke') || held.has('workbench.access');

  // Resolved from memberships alone. A slug the user does not belong to is
  // ignored rather than honoured — the same rule `requireTenantContext()`
  // applies on the server, and the reason the cookie is a preference.
  const preferred = activeTenantSlug
    ? tenants.find((t) => t.slug === activeTenantSlug || t.id === activeTenantSlug)
    : undefined;
  const selectedTenant: TenantOption | null = preferred ?? tenants[0] ?? null;

  const selectedTenantId = selectedTenant?.id ?? null;
  const killOn = killState?.tenantId === selectedTenantId ? killState.engaged : null;
  const visibleAlertsSummary = alertsSummary?.tenantId === selectedTenantId ? alertsSummary : null;

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
            setKillState({ tenantId: selectedTenantId, engaged: data.engaged });
          }
        }
      } catch {
        // Fallback
      }
    }
    fetchKillStatus();

    const handleEvent = () => {
      // Global browser events do not carry a tenant-bound proof. Re-read the
      // selected tenant's BFF status instead of trusting their boolean payload.
      setKillState(null);
      void fetchKillStatus();
    };
    window.addEventListener('axiom:kill-switch-changed', handleEvent);
    return () => {
      active = false;
      window.removeEventListener('axiom:kill-switch-changed', handleEvent);
    };
  }, [selectedTenantId]);

  useEffect(() => {
    let active = true;
    async function fetchAlerts() {
      if (!selectedTenantId) return;
      try {
        const res = await fetch('/api/bff/v1/monitoring/alerts?limit=10', {
          headers: { 'X-Tenant-Id': selectedTenantId },
        });
        if (res.ok) {
          const body = await res.json();
          const parsed = alertReadSchema.safeParse(body);
          if (active && parsed.success) {
            const { summary, alerts } = parsed.data.data;
            setAlertsSummary({
              tenantId: selectedTenantId,
              unread: summary.unread,
              critical: summary.critical,
              high: summary.high,
              alerts: alerts.filter((a) => a.status === 'unread' || a.status === 'read'),
            });
            return;
          }
        }
        if (active) setAlertsSummary(null);
      } catch {
        if (active) setAlertsSummary(null);
      }
    }
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedTenantId]);

  async function handleToggleKillSwitch() {
    if (!selectedTenantId || !canKillSwitch || killOn === null) return;
    if (killOn && !canReleaseKill) return;
    setKillError(null);
    if (!killOn) {
      if (
        !confirm(
          'ENGAGE KILL SWITCH?\n\nThis engages the stop for this tenant. Enforced checks refuse new work. Running work stops at its next enforced checkpoint.',
        )
      )
        return;
      try {
        const res = await fetch('/api/bff/v1/kill-switch/engage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': selectedTenantId },
          body: JSON.stringify({ scope: 'tenant', reason: 'Engaged from navigation bar' }),
        });
        if (res.ok && (await res.json().catch(() => null))?.engaged === true) {
          setKillState({ tenantId: selectedTenantId, engaged: true });
          window.dispatchEvent(
            new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }),
          );
        } else if (res.ok) {
          setKillState(null);
        }
      } catch (err) {
        setKillState(null);
        console.error('Failed to engage kill switch:', err);
      }
    } else {
      if (
        !confirm(
          'DISENGAGE KILL SWITCH?\n\nThis removes this tenant stop. Other stops and normal approval checks still apply; interrupted work does not automatically resume.',
        )
      )
        return;
      try {
        const res = await fetch('/api/bff/v1/kill-switch/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': selectedTenantId },
        });
        if (res.ok && (await res.json().catch(() => null))?.engaged === false) {
          setKillState({ tenantId: selectedTenantId, engaged: false });
          window.dispatchEvent(
            new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: false } }),
          );
        } else if (res.ok) {
          setKillState(null);
        } else {
          const body = await res.json().catch(() => null);
          setKillError(
            body?.error?.message ?? `The kill switch could not be released (HTTP ${res.status}).`,
          );
        }
      } catch (err) {
        setKillState(null);
        setKillError('The kill switch could not be released. Try again.');
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
      router.refresh();
    } finally {
      setSwitching(false);
    }
  };

  // Find active group and item for breadcrumb
  let activeBreadcrumb = 'Overview';
  let activeTitle = 'Dashboard';

  const standaloneRouteContext: Record<string, { breadcrumb: string; title: string }> = {
    '/portal': { breadcrumb: 'Operate', title: 'Client Portal' },
    '/engagements': { breadcrumb: 'Assess', title: 'Engagements' },
    '/onboarding': { breadcrumb: 'Overview', title: 'Enterprise Onboarding' },
  };
  const standalone =
    standaloneRouteContext[pathname] ??
    (pathname.startsWith('/engagements/') ? standaloneRouteContext['/engagements'] : undefined);
  if (standalone) {
    activeBreadcrumb = standalone.breadcrumb;
    activeTitle = standalone.title;
  }

  for (const group of navGroups) {
    for (const item of group.items) {
      if (isItemActive(item.route)) {
        activeBreadcrumb = group.label;
        activeTitle = item.en;
        break;
      }
    }
  }

  const sidebarContent = (
    <>
      {/* Brand Header */}
      <div className="flex h-14 shrink-0 items-center px-5 border-b border-white/10">
        <Link href="/dashboard" prefetch={false} className="flex items-center gap-3">
          <AxiomLogo size="md" theme="dark" showSubtitle={true} />
        </Link>
      </div>

      {/* Navigation Stream */}
      <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto py-2">
        {navGroups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="truncate px-5 pt-3 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase text-[#7d89ad]">
              {group.label}
            </div>
            {group.items.map((item) => {
              const isActive = isItemActive(item.route);
              const isGold = !!item.gold;

              const activeClasses = isGold
                ? 'border-l-[3px] border-[#C9A227] bg-[#C9A227]/15 text-white font-semibold shadow-sm'
                : 'border-l-[3px] border-[#0FB5A5] bg-[#0FB5A5]/10 text-white font-semibold';

              const idleClasses = isGold
                ? 'border-l-[3px] border-transparent text-[#e6cf8b] hover:bg-[#C9A227]/10'
                : 'border-l-[3px] border-transparent text-[#c7cfe0] hover:bg-white/5';

              const dotClasses = isActive
                ? isGold
                  ? 'bg-[#C9A227]'
                  : 'bg-[#0FB5A5]'
                : isGold
                  ? 'bg-[#C9A227]/60'
                  : 'bg-[#3d4863]';

              const starColor = isGold ? 'text-[#C9A227]' : 'text-[#0FB5A5]';

              const badgeClasses = isGold
                ? isActive
                  ? 'bg-[#C9A227]/30 text-[#F5DE93] border border-[#C9A227]/60 font-bold'
                  : 'bg-[#C9A227]/15 text-[#C9A227] border border-[#C9A227]/30 font-semibold'
                : isActive
                  ? 'bg-white/20 text-white'
                  : 'bg-white/5 text-[#8a97b8]';

              return (
                <Link
                  key={item.route}
                  href={item.route}
                  // Protected pages verify auth and tenant context; load them on navigation.
                  prefetch={false}
                  title={item.agentRole ? `${item.en} (${item.agentRole})` : item.en}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => mobileNav.current?.close()}
                  className={`flex min-h-11 lg:min-h-0 items-center gap-2.5 px-5 py-1.5 transition-colors ${
                    isActive ? activeClasses : idleClasses
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClasses}`} />
                  <span className="flex flex-1 flex-col min-w-0">
                    {/* One line per item: the Hindi name gives way first (it
                        collapses before the English label wraps), so items keep
                        an even rhythm. */}
                    <span className="flex min-w-0 items-baseline gap-x-1.5 text-[13px] leading-snug">
                      <span
                        className={`max-w-full shrink-0 ${
                          isActive ? 'text-white' : isGold ? 'text-[#f0dfaa]' : 'text-[#c7cfe0]'
                        }`}
                      >
                        {item.en}
                      </span>
                      {item.hi && (
                        <span
                          lang="hi"
                          className={`min-w-0 shrink-[999] truncate font-heading text-[10.5px] font-normal ${isGold ? 'text-[#bfa460]' : 'text-[#6f7ba0]'}`}
                        >
                          {item.hi}
                        </span>
                      )}
                    </span>
                    {item.agentRole && (
                      <span
                        className={`text-[10px] truncate ${isGold ? (isActive ? 'text-[#E5C158]' : 'text-[#C9A227]/80') : isActive ? 'text-[#0FB5A5]' : 'text-[#6f7ba0]'}`}
                      >
                        {item.agentRole}
                      </span>
                    )}
                  </span>
                  {item.star && <span className={`${starColor} text-xs font-bold`}>★</span>}
                  <span
                    className={`text-[8.5px] font-semibold tracking-wider px-1.5 py-0.5 rounded ${badgeClasses}`}
                  >
                    {item.phase}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {canSeeAgents && (
        <details className="group shrink-0 border-t border-white/10">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7d89ad] hover:text-white [&::-webkit-details-marker]:hidden">
            <span>Agents</span>
            <span aria-hidden className="transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <SidebarAgentPanel
            tenantId={selectedTenantId}
            capabilities={capabilities}
            transparent
            className="border-t-0 pt-0"
          />
        </details>
      )}
      {/* User Profile Bar */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-white/10 bg-[#182238]/70 px-4 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0FB5A5] font-heading text-xs font-bold text-[#1E2A4A]">
          {(user.user_metadata?.full_name ?? user.email ?? 'P')[0]?.toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-white">
            {user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Signed-in user'}
          </div>
          <div className="text-[10px] text-[#6f7ba0]">
            {selectedTenant?.role ?? 'No active membership'}
          </div>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            title="Sign out"
            className="rounded px-2 py-1 text-[11px] text-[#A6B0CC] transition-colors hover:bg-white/10 hover:text-white"
          >
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-[#F4F6F8]">
      {/* ============ SIDEBAR ============ */}
      <aside className="sticky top-0 z-30 hidden h-screen w-[252px] shrink-0 flex-col bg-[#1E2A4A] text-[#c7cfe0] border-r border-white/10 lg:flex">
        {sidebarContent}
      </aside>
      <dialog
        id="mobile-navigation"
        ref={mobileNav}
        aria-label="Application navigation"
        onClose={() => setNavigationOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), [tabindex="0"]',
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) mobileNav.current?.close();
        }}
        className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(86vw,300px)] max-w-none border-0 bg-[#1E2A4A] p-0 text-[#c7cfe0] backdrop:bg-black/50 lg:hidden"
      >
        <div className="flex h-full flex-col">
          <button
            type="button"
            className="min-h-11 border-b border-white/10 px-5 py-3 text-left text-sm text-white"
            onClick={() => mobileNav.current?.close()}
          >
            Close navigation
          </button>
          {sidebarContent}
        </div>
      </dialog>

      {/* ============ MAIN AREA ============ */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex min-h-14 flex-wrap shrink-0 items-center gap-2 border-b border-[#e4e8ee] bg-white/95 px-3 py-2 backdrop-blur sm:flex-nowrap sm:gap-3 sm:px-4 xl:px-5">
          <button
            type="button"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-controls="mobile-navigation"
            aria-expanded={navigationOpen}
            className="min-h-11 rounded border border-slate-300 px-3 text-sm lg:hidden"
            onClick={() => {
              mobileNav.current?.showModal();
              setNavigationOpen(true);
            }}
          >
            Menu
          </button>
          {/* One breadcrumb line. The page's own header carries the h1, so the
              bar no longer repeats the title at heading weight. */}
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
          >
            <span className="truncate text-slate-500">{activeBreadcrumb}</span>
            <span aria-hidden className="text-slate-300">
              /
            </span>
            <span className="truncate font-semibold text-[#1E2A4A]">{activeTitle}</span>
          </nav>

          {/* Tenant Switcher */}
          <div className="relative">
            <button
              type="button"
              aria-label="Switch organization"
              aria-expanded={tenantsOpen}
              aria-controls="organization-choices"
              onClick={() => setTenantsOpen(!tenantsOpen)}
              className="flex min-h-10 max-w-[180px] sm:max-w-[240px] items-center gap-2.5 rounded-lg border border-[#e4e8ee] bg-white px-2.5 py-1 cursor-pointer hover:border-[#0FB5A5] transition-colors"
            >
              <span
                style={{
                  backgroundColor: selectedTenant ? tenantColor(selectedTenant.id) : '#8a909b',
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md font-heading text-[11px] font-bold text-white"
              >
                {selectedTenant ? tenantMark(selectedTenant.name) : '—'}
              </span>
              <div className="min-w-0 leading-tight text-left">
                <div className="truncate text-xs font-semibold text-[#2F3542]">
                  {selectedTenant?.name ?? 'No organization'}
                </div>
                {/* The role, which is a fact. What stood here was an invented
                    sector ("Enterprise") shown as if it were tenant data. */}
                <div className="text-[10px] text-[#8a909b]">
                  {selectedTenant?.role ?? 'no membership'}
                </div>
              </div>
              <span className="text-[10px] text-[#8a909b] ml-1">▾</span>
            </button>

            {tenantsOpen && (
              <div
                id="organization-choices"
                className="absolute right-0 top-12 z-50 w-72 rounded-xl border border-[#e4e8ee] bg-white p-1.5 shadow-xl max-h-[420px] overflow-y-auto"
              >
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
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => void handleSelectTenant(t)}
                        disabled={switching}
                        className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg p-2 transition-colors ${
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
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-[11px] text-[#8a909b]">
                    You are not a member of any organization yet.
                  </div>
                )}

                {canCreateTenant && (
                  <div className="mt-1 border-t border-[#eef1f5] pt-1">
                    <Link
                      href="/onboarding"
                      prefetch={false}
                      onClick={() => setTenantsOpen(false)}
                      className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-700 hover:bg-teal-100 transition-colors"
                    >
                      <span>+ Onboard New Organization</span>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Continuous Monitoring Alerts Bell & Tray */}
          <div className="relative">
            <button
              type="button"
              aria-label="Continuous monitoring alerts"
              aria-expanded={alertsOpen}
              onClick={() => setAlertsOpen(!alertsOpen)}
              className="relative flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-[#e4e8ee] bg-white px-2.5 text-slate-500 hover:border-[#0FB5A5] hover:text-[#1E2A4A] transition-colors"
              title="Continuous monitoring alerts"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-[18px] w-[18px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {(visibleAlertsSummary?.unread ?? 0) > 0 && (
                <span
                  className={`absolute -top-1.5 -right-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow ${
                    (visibleAlertsSummary?.critical ?? 0) > 0 ||
                    (visibleAlertsSummary?.high ?? 0) > 0
                      ? 'bg-[#D9534F]'
                      : 'bg-[#0FB5A5]'
                  }`}
                >
                  {visibleAlertsSummary?.unread}
                </span>
              )}
            </button>

            {alertsOpen && (
              <div className="absolute right-0 top-12 z-50 w-80 sm:w-96 rounded-xl border border-[#e4e8ee] bg-white p-3 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <span className="text-xs font-semibold text-[#1E2A4A]">Continuous Alerts</span>
                  <Link
                    href="/monitoring"
                    prefetch={false}
                    onClick={() => setAlertsOpen(false)}
                    className="text-[11px] font-medium text-[#0FB5A5] hover:underline"
                  >
                    View monitoring →
                  </Link>
                </div>
                <div className="mt-2 flex flex-col gap-2 max-h-72 overflow-y-auto">
                  {visibleAlertsSummary === null ? (
                    <div role="alert" className="py-4 text-center text-xs text-slate-500">
                      Alert status is unavailable.
                    </div>
                  ) : visibleAlertsSummary.alerts.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-500">
                      No alerts in this loaded page.
                    </div>
                  ) : (
                    visibleAlertsSummary.alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 text-xs text-slate-700"
                      >
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white ${
                              alert.severity === 'critical' || alert.severity === 'high'
                                ? 'bg-[#D9534F]'
                                : 'bg-slate-500'
                            }`}
                          >
                            {alert.severity}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {formatTime(alert.created_at)}
                          </span>
                        </div>
                        <p className="font-medium text-slate-800 line-clamp-1">{alert.title}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                          {alert.summary}
                        </p>
                      </div>
                    ))
                  )}
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
              disabled={!selectedTenantId || killOn === null || (killOn && !canReleaseKill)}
              className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
                killOn
                  ? 'border-[#D9534F] bg-[#D9534F] text-white shadow-sm animate-pulse'
                  : 'border-[#e4e8ee] bg-white text-[#D9534F] hover:bg-[#FCEEEC]'
              }`}
              title={
                killOn && !canReleaseKill
                  ? 'Engaged. An authorized owner or founder can release this tenant stop.'
                  : 'Halt autonomous agent execution for this tenant'
              }
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 3v9" />
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              </svg>
              {killOn === null
                ? 'Kill switch status unavailable'
                : killOn
                  ? 'Kill switch active'
                  : 'Kill switch'}
            </button>
          )}
        </header>

        {/* Global Kill Switch Alert Banner */}
        {killOn && (
          <div className="flex items-center justify-between bg-[#D9534F] px-4 py-2 text-xs font-semibold text-white shadow-inner xl:px-5">
            <div className="flex items-center gap-2">
              <span className="text-sm">⏻</span>
              <span>KILL SWITCH ENGAGED — Running work stops at its next enforced checkpoint.</span>
            </div>
            <div className="flex items-center gap-3">
              {killError && (
                <span role="alert" className="font-normal">
                  {killError}
                </span>
              )}
              {canReleaseKill ? (
                <button
                  onClick={handleToggleKillSwitch}
                  className="font-normal underline hover:text-white/80 cursor-pointer"
                >
                  Disengage
                </button>
              ) : (
                <span className="font-normal text-white/85">
                  An authorized owner or founder can release this tenant stop.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Main Content Viewport */}
        <main className="min-w-0 flex-1 px-3 py-3 sm:px-4 sm:py-4 xl:px-5">{children}</main>
      </div>
    </div>
  );
}
