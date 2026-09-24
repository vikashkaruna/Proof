'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, Input, Label } from '@axiom/ui';
import type { OnboardingReadiness, OnboardingWizard, OnboardingWizardStep } from '@axiom/types';
import { MutationForm } from '../estate-client';
import { DriftCard } from './sustenance';

export interface WizardEstate {
  id: string;
  name: string;
  status: 'active' | 'archived';
}
export interface WizardSystem {
  id: string;
  estateId: string;
  name: string;
  active: boolean;
  declaredCategories: string[];
  hasConnector: boolean;
}
interface Profile {
  is_sdf: boolean;
  processes_children_data: boolean;
  processes_health_data: boolean;
  dpo_name: string | null;
  dpo_email: string | null;
}

const STEPS: { key: OnboardingWizardStep; label: string }[] = [
  { key: 'company', label: 'Company profile' },
  { key: 'estate', label: 'Estate' },
  { key: 'inventory', label: 'System inventory' },
  { key: 'connectors', label: 'Connection path' },
  { key: 'grants', label: 'Access grant review' },
  { key: 'readiness', label: 'Readiness' },
];
const CHECK_LABELS: Record<string, string> = {
  company_profile: 'Company profile and DPO contact recorded',
  estate_active: 'An active estate is selected',
  systems_declared: 'At least one active system is declared',
  data_categories_declared: 'Every system has declared data categories',
  connection_path_recorded: 'Every system has a registered connector or is marked manual',
  grants_reviewed: 'Access grants reviewed',
};

type Loaded =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; wizard: OnboardingWizard | null; readiness: OnboardingReadiness | null };

async function fetchWizard(tenantId: string): Promise<Loaded> {
  try {
    const res = await fetch('/api/bff/v1/onboarding/wizard', {
      headers: { 'X-Tenant-Id': tenantId },
      cache: 'no-store',
    });
    if (!res.ok) return { state: 'error' };
    const body = (await res.json()) as {
      data: OnboardingWizard | null;
      readiness: OnboardingReadiness | null;
    };
    return { state: 'ready', wizard: body.data, readiness: body.readiness };
  } catch {
    return { state: 'error' };
  }
}

export function SetupWizard({
  tenantId,
  canManage,
  profile,
  estates,
  systems,
}: {
  tenantId: string;
  canManage: boolean;
  profile: Profile | null;
  estates: WizardEstate[];
  systems: WizardSystem[];
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [selected, setSelected] = useState<OnboardingWizardStep | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchWizard(tenantId).then((result) => {
      if (active) setLoaded(result);
    });
    return () => {
      active = false;
    };
  }, [tenantId, revision]);

  if (loaded.state === 'loading') return <p role="status">Loading onboarding progress…</p>;
  if (loaded.state === 'error')
    return <p role="alert">Onboarding progress is unavailable. Refresh to try again.</p>;
  const { wizard, readiness } = loaded;
  const open = wizard?.status === 'in_progress' ? wizard : null;
  const done = new Set(open?.completed_steps ?? []);
  const next = STEPS.find((s) => !done.has(s.key))?.key ?? 'readiness';
  const current = selected && (done.has(selected) || selected === next) ? selected : next;
  const steps = `/onboarding/wizard/${open?.id}/steps`;
  const version = open?.version ?? 0;
  const estateSystems = systems.filter((s) => s.active && s.estateId === open?.estate_id);
  const reload = () => {
    setSelected(null);
    setRevision((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="setup-wizard">
      {wizard?.status === 'completed' && (
        <p role="status" data-testid="setup-complete">
          Onboarding completed on {new Date(wizard.completed_at ?? '').toLocaleDateString()}. The
          readiness snapshot below is what was confirmed at that time.
        </p>
      )}
      {wizard?.status === 'completed' && wizard.estate_id && (
        <DriftCard tenantId={tenantId} estateId={wizard.estate_id} />
      )}
      {!open && canManage && (
        <MutationForm
          tenantId={tenantId}
          path="/onboarding/wizard"
          method="POST"
          body={() => ({})}
          label={wizard ? 'Start re-onboarding' : 'Start onboarding'}
          onSuccess={reload}
        >
          <p className="text-sm">Progress is saved after every step, so you can stop and resume.</p>
        </MutationForm>
      )}
      {!open && !canManage && !wizard && <p>No onboarding run has been started.</p>}

      {open && (
        <>
          <ol className="flex flex-wrap gap-2" aria-label="Onboarding steps">
            {STEPS.map((s, i) => {
              const reachable = done.has(s.key) || s.key === next;
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    disabled={!reachable}
                    aria-current={s.key === current ? 'step' : undefined}
                    onClick={() => setSelected(s.key)}
                    className={`rounded-md border px-3 py-1 text-sm ${s.key === current ? 'border-teal-600 font-semibold' : ''}`}
                  >
                    {i + 1}. {s.label} {done.has(s.key) ? '✓' : ''}
                  </button>
                </li>
              );
            })}
          </ol>
          <Card>
            <CardHeader>
              <CardTitle>{STEPS.find((s) => s.key === current)?.label}</CardTitle>
            </CardHeader>
            {/* Keyed so each step gets a fresh form: no stale message or retry key. */}
            <CardContent key={current}>
              {!canManage ? (
                <p>Only owners and admins can complete onboarding steps.</p>
              ) : current === 'company' ? (
                <MutationForm
                  tenantId={tenantId}
                  path={steps}
                  method="POST"
                  label="Save company profile"
                  onSuccess={reload}
                  body={(f) => ({
                    step: 'company',
                    expectedVersion: version,
                    dpoName: String(f.get('dpoName') ?? ''),
                    dpoEmail: String(f.get('dpoEmail') ?? ''),
                    isSdf: f.get('isSdf') === 'on',
                    processesChildrenData: f.get('children') === 'on',
                    processesHealthData: f.get('health') === 'on',
                  })}
                >
                  <Label htmlFor="dpoName">Data Protection Officer name</Label>
                  <Input
                    id="dpoName"
                    name="dpoName"
                    required
                    defaultValue={profile?.dpo_name ?? ''}
                  />
                  <Label htmlFor="dpoEmail">DPO email</Label>
                  <Input
                    id="dpoEmail"
                    name="dpoEmail"
                    type="email"
                    required
                    defaultValue={profile?.dpo_email ?? ''}
                  />
                  {(
                    [
                      ['isSdf', 'Notified as a Significant Data Fiduciary', profile?.is_sdf],
                      ['children', 'Processes children’s data', profile?.processes_children_data],
                      ['health', 'Processes health data', profile?.processes_health_data],
                    ] as const
                  ).map(([name, label, value]) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name={name} defaultChecked={Boolean(value)} /> {label}
                    </label>
                  ))}
                </MutationForm>
              ) : current === 'estate' ? (
                estates.some((e) => e.status === 'active') ? (
                  <MutationForm
                    tenantId={tenantId}
                    path={steps}
                    method="POST"
                    label="Use this estate"
                    onSuccess={reload}
                    body={(f) => ({
                      step: 'estate',
                      expectedVersion: version,
                      estateId: String(f.get('estateId') ?? ''),
                    })}
                  >
                    <Label htmlFor="estateId">Assessment boundary</Label>
                    <select
                      id="estateId"
                      name="estateId"
                      defaultValue={open.estate_id ?? ''}
                      required
                      className="w-full rounded-md border border-input bg-background p-2 text-sm"
                    >
                      <option value="" disabled>
                        Choose an estate
                      </option>
                      {estates
                        .filter((e) => e.status === 'active')
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                    <p className="text-sm">Changing the estate clears the steps after this one.</p>
                  </MutationForm>
                ) : (
                  <p>
                    Create an estate first on <Link href="/estate">the estate page</Link>, then
                    return here.
                  </p>
                )
              ) : current === 'inventory' ? (
                <MutationForm
                  tenantId={tenantId}
                  path={steps}
                  method="POST"
                  label="Confirm inventory"
                  onSuccess={reload}
                  body={() => ({ step: 'inventory', expectedVersion: version })}
                >
                  {estateSystems.length === 0 ? (
                    <p>No active systems are declared in this estate yet.</p>
                  ) : (
                    <ul className="text-sm" data-testid="inventory-list">
                      {estateSystems.map((s) => (
                        <li key={s.id}>
                          {s.name}:{' '}
                          {s.declaredCategories.length
                            ? s.declaredCategories.join(', ')
                            : 'no declared data categories'}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-sm">
                    Add systems or data categories on <Link href="/estate">the estate page</Link>.
                  </p>
                </MutationForm>
              ) : current === 'connectors' ? (
                <MutationForm
                  tenantId={tenantId}
                  path={steps}
                  method="POST"
                  label="Record connection path"
                  onSuccess={reload}
                  body={(f) => ({
                    step: 'connectors',
                    expectedVersion: version,
                    manualSystemIds: f.getAll('manual').map(String),
                  })}
                >
                  <p className="text-sm">
                    A registered connector is only a registration; it is not evidence of a live
                    connection. Systems without one can be assessed with manual evidence.
                  </p>
                  {estateSystems.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="manual"
                        value={s.id}
                        defaultChecked={open.manual_system_ids.includes(s.id)}
                      />
                      {s.name}: {s.hasConnector ? 'connector registered' : 'no connector'} — assess
                      manually
                    </label>
                  ))}
                  <p className="text-sm">
                    Register connectors on <Link href="/connectors">the connectors page</Link>.
                  </p>
                </MutationForm>
              ) : current === 'grants' ? (
                <MutationForm
                  tenantId={tenantId}
                  path={steps}
                  method="POST"
                  label="Record grant review"
                  onSuccess={reload}
                  body={() => ({ step: 'grants', expectedVersion: version, acknowledged: true })}
                >
                  <p className="text-sm" data-testid="grant-counts">
                    Active agent grants on this estate: {readiness?.counts.activeReadGrants ?? 0}{' '}
                    read, {readiness?.counts.activeWriteGrants ?? 0} write. This wizard never issues
                    grants; confirming records that you reviewed them.
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="acknowledged" required /> I have reviewed agent
                    access for this estate
                  </label>
                </MutationForm>
              ) : (
                <MutationForm
                  tenantId={tenantId}
                  path={steps}
                  method="POST"
                  label="Confirm readiness"
                  onSuccess={reload}
                  body={() => ({ step: 'readiness', expectedVersion: version, confirmed: true })}
                >
                  <p className="text-sm">
                    Checks are re-evaluated from live data when you confirm.
                  </p>
                </MutationForm>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {readiness && (
        <Card>
          <CardHeader>
            <CardTitle>Readiness checks</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm" data-testid="readiness-checks">
              {readiness.checks.map((c) => (
                <li key={c.key} data-ok={c.ok}>
                  {c.ok ? '✓' : '✗'} {CHECK_LABELS[c.key] ?? c.key}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
