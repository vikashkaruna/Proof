'use client';

import React, { useState, useEffect, useRef } from 'react';
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

const TENANT_COLORS = ['#1E2A4A', '#0FB5A5', '#475569', '#5B6BA8', '#7A5C9E', '#3F7D6B'];

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
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsSummary, setAlertsSummary] = useState<{
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
          if (active && body?.data?.summary) {
            setAlertsSummary({
              unread: body.data.summary.unread ?? 0,
              critical: body.data.summary.critical ?? 0,
              high: body.data.summary.high ?? 0,
              alerts: (body.data.alerts ?? []).filter(
                (a: { status: string }) => a.status === 'unread' || a.status === 'read',
              ),
            });
          }
        }
      } catch {
        // silent
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

  const sidebarContent = (
    <>
      {/* Brand Header */}
      <div className="flex h-16 shrink-0 items-center px-5 border-b border-white/10">
        <Link href="/dashboard" className="flex items-center gap-3">
          <AxiomLogo size="md" theme="dark" showSubtitle={true} />
        </Link>
      </div>

      {/* Navigation Stream */}
      <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto py-2">
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
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => mobileNav.current?.close()}
                  className={`flex min-h-11 lg:min-h-0 items-center gap-2.5 px-5 py-1.5 transition-colors ${
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
                  {item.star && <span className="text-[#0FB5A5] text-xs">★</span>}
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
      </nav>

      {/* User Profile Bar */}
      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3 bg-[#182238]/60">
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
            className="text-[11px] text-[#8a909b] hover:text-white transition-colors"
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
      <aside className="sticky top-0 z-30 hidden h-screen w-[266px] shrink-0 flex-col bg-[#1E2A4A] text-[#c7cfe0] border-r border-white/10 lg:flex">
        {sidebarContent}
        <SidebarAgentPanel />
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
        <header className="sticky top-0 z-20 flex min-h-[60px] flex-wrap shrink-0 items-center gap-2 border-b border-[#e4e8ee] bg-white px-3 py-2 sm:flex-nowrap sm:gap-4 sm:px-6">
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
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-[#8a909b] truncate">{activeBreadcrumb}</div>
            <h1 className="font-heading text-[17px] font-semibold leading-tight text-[#1E2A4A] truncate">
              {activeTitle}
            </h1>
          </div>

          {/* Tenant Switcher */}
          <div className="relative">
            <button
              type="button"
              aria-label="Switch organization"
              aria-expanded={tenantsOpen}
              aria-controls="organization-choices"
              onClick={() => setTenantsOpen(!tenantsOpen)}
              className="flex min-h-11 max-w-[180px] sm:max-w-[240px] items-center gap-2.5 rounded-lg border border-[#e4e8ee] bg-white px-3 py-1.5 cursor-pointer shadow-sm hover:border-[#0FB5A5] transition-colors"
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

          {/* Continuous Monitoring Alerts Bell & Tray */}
          <div className="relative">
            <button
              type="button"
              aria-label="Continuous monitoring alerts"
              aria-expanded={alertsOpen}
              onClick={() => setAlertsOpen(!alertsOpen)}
              className="relative flex min-h-11 items-center justify-center rounded-lg border border-[#e4e8ee] bg-white px-3 py-1.5 shadow-sm hover:border-[#0FB5A5] transition-colors"
              title="Continuous monitoring alerts"
            >
              <span className="text-sm">🔔</span>
              {(alertsSummary?.unread ?? 0) > 0 && (
                <span
                  className={`absolute -top-1.5 -right-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow ${
                    (alertsSummary?.critical ?? 0) > 0 ? 'bg-[#D9534F]' : 'bg-[#C9A227]'
                  }`}
                >
                  {alertsSummary?.unread}
                </span>
              )}
            </button>

            {alertsOpen && (
              <div className="absolute right-0 top-12 z-50 w-80 sm:w-96 rounded-xl border border-[#e4e8ee] bg-white p-3 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <span className="text-xs font-semibold text-[#1E2A4A]">Continuous Alerts</span>
                  <Link
                    href="/monitoring"
                    onClick={() => setAlertsOpen(false)}
                    className="text-[11px] font-medium text-[#0FB5A5] hover:underline"
                  >
                    View monitoring →
                  </Link>
                </div>
                <div className="mt-2 flex flex-col gap-2 max-h-72 overflow-y-auto">
                  {!alertsSummary?.alerts || alertsSummary.alerts.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-500">
                      No active unacknowledged alerts
                    </div>
                  ) : (
                    alertsSummary.alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 text-xs text-slate-700"
                      >
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white ${
                              alert.severity === 'critical'
                                ? 'bg-[#D9534F]'
                                : alert.severity === 'high'
                                  ? 'bg-[#C9A227]'
                                  : 'bg-slate-500'
                            }`}
                          >
                            {alert.severity}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {new Date(alert.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
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
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-8 sm:py-7">{children}</main>
      </div>
    </div>
  );
}
