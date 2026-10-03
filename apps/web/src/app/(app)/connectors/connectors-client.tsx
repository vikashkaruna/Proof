'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { ConnectorManifestSchema, type ConnectorManifest } from '@axiom/types';
import { DataPlaceholder } from '@axiom/ui';
import { MutationForm } from '../estate/estate-client';

export interface ConnectorRow {
  id: string;
  system_id: string;
  name: string;
  endpoint_ref: string;
  descriptor_id: string;
  target_binding: string;
  assurance: string;
  status: 'draft' | 'active' | 'disabled' | 'archived';
  version: number;
  connector_health_checks: HealthRow[];
}
export interface ConnectorSystem {
  id: string;
  name: string;
  status: string;
  estates: { name: string; status: string };
}
export interface HealthRow {
  status: string;
  checked_at: string;
}
const inputClass = 'block w-full rounded border p-2';
const readinessSchema = z.object({
  data: z.object({
    connectorId: z.uuid(),
    registrationStatus: z.enum(['draft', 'active', 'disabled', 'archived']),
    credentialConfigured: z.boolean(),
    readGrantConfigured: z.boolean(),
    lastObservation: z
      .object({
        status: z.enum(['healthy', 'degraded', 'unreachable']),
        checked_at: z.string(),
        error_code: z.string().nullable(),
      })
      .nullable(),
    liveCheckAvailable: z.literal(false),
  }),
});
type Readiness = z.infer<typeof readinessSchema>['data'];

function SetupStatus({ tenantId, connectorId }: { tenantId: string; connectorId: string }) {
  const [status, setStatus] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(`/api/bff/v1/connectors/${connectorId}/readiness`, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Readiness unavailable');
      const parsed = readinessSchema.parse(await response.json());
      if (parsed.data.connectorId !== connectorId) throw new Error('Unexpected connector');
      setStatus(parsed.data);
    } catch {
      setStatus(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-indigo-900">Connection setup status</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded-md border border-teal-700 px-3 py-2 font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50"
        >
          {busy ? 'Checking setup…' : 'Check setup status'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-ember-700">
          Setup status could not be loaded. Try again.
        </p>
      )}
      {status && (
        <ul className="mt-3 list-inside list-disc space-y-1" aria-label="Connection setup checks">
          <li>
            Registration:{' '}
            {status.registrationStatus === 'active' ? 'enabled' : status.registrationStatus}
          </li>
          <li>
            Broker credential: {status.credentialConfigured ? 'configured' : 'not configured'}
          </li>
          <li>
            Drishti read grant: {status.readGrantConfigured ? 'configured' : 'not configured'}
          </li>
          <li>
            Last recorded observation:{' '}
            {status.lastObservation
              ? `${status.lastObservation.status} at ${status.lastObservation.checked_at}`
              : 'none'}
          </li>
        </ul>
      )}
      <p className="mt-3 text-slate-600">
        This refresh checks saved setup records only. A live connection test is not available from
        this screen; a prior health observation does not prove current reachability.
      </p>
    </div>
  );
}
function RegistrationFields({ row }: { row?: ConnectorRow }) {
  return (
    <>
      <label className="block">
        Registration name
        <input
          className={inputClass}
          name="name"
          defaultValue={row?.name}
          required
          maxLength={200}
        />
      </label>
      <label className="block">
        Endpoint reference
        <input
          className={inputClass}
          name="endpointRef"
          defaultValue={row?.endpoint_ref}
          required
          pattern="[a-z][a-z0-9_\-]{0,79}"
          maxLength={80}
        />
      </label>
      <p className="text-sm text-slate-600">
        Use a non-secret identifier such as primary_crm. Connection addresses and credentials are
        configured separately.
      </p>
    </>
  );
}
export function ConnectorsClient({
  tenantId,
  canManage,
  connectors,
  systems,
}: {
  tenantId: string;
  canManage: boolean;
  connectors: ConnectorRow[];
  systems: ConnectorSystem[];
}) {
  const [catalogue, setCatalogue] = useState<ConnectorManifest[] | null>(null);
  const [catalogueError, setCatalogueError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/bff/v1/connector-catalogue', {
          headers: { 'X-Tenant-Id': tenantId },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unavailable');
        const payload: { data?: unknown } = await response.json();
        const descriptors = ConnectorManifestSchema.array().parse(payload.data);
        if (!controller.signal.aborted) {
          setCatalogue(descriptors);
          setCatalogueError(false);
        }
      } catch {
        if (!controller.signal.aborted) setCatalogueError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [tenantId]);
  const availableSystems = systems.filter(
    (s) => s.status === 'active' && s.estates.status === 'active',
  );
  return (
    <>
      <section
        aria-label="Connection setup"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <h2 className="text-lg font-semibold text-indigo-900">Set up a connection path</h2>
        <ol className="list-inside list-decimal space-y-2 text-sm text-slate-700">
          <li>
            <Link href="/estate" className="text-teal-700 underline">
              Add an active estate and system
            </Link>
            .
          </li>
          <li>Choose a reviewed descriptor and register a non-secret endpoint reference below.</li>
          <li>
            Have the operator configure the private endpoint and broker credential for that
            reference. Never enter a connection URL, password, token, or secret here.
          </li>
          <li>
            Enable the registration, then{' '}
            <Link href="/estate/setup" className="text-teal-700 underline">
              review agent access in estate setup
            </Link>
            . A grant is a separate recorded human action.
          </li>
          <li>
            Use “Check setup status” on the registration to inspect recorded configuration. A live
            transport check needs the private workload and broker.
          </li>
        </ol>
      </section>
      <section aria-label="Available connector options" className="space-y-3">
        <h2 className="text-lg font-semibold text-indigo-900">Available connector options</h2>
        {catalogue === null && !catalogueError && <p role="status">Loading reviewed options…</p>}
        {catalogue?.length === 0 && <p>No reviewed connector options are available.</p>}
        {catalogue && catalogue.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {catalogue.map((descriptor) => (
              <li
                key={descriptor.id}
                className="rounded-lg border border-slate-200 bg-white p-4 text-sm"
              >
                <strong className="block text-indigo-900">
                  {descriptor.target} · {descriptor.version}
                </strong>
                <span className="block">
                  {descriptor.transport.toUpperCase()} ·{' '}
                  {descriptor.targetBinding === 'production'
                    ? 'Production · operator setup required'
                    : 'Reference only'}{' '}
                  · {descriptor.auth.replaceAll('_', ' ')}
                </span>
                <span className="mt-1 block text-slate-600">
                  {descriptor.provenance === 'vendor-verified'
                    ? 'Vendor verified'
                    : descriptor.targetBinding === 'production'
                      ? 'Requires private network, broker credential and workload verification before use.'
                      : 'Reference descriptor; not proof of vendor connectivity'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {catalogueError && (
        <p role="alert">
          The reviewed connector catalogue could not be loaded. Refresh to try again.
        </p>
      )}
      {canManage && availableSystems.length === 0 && (
        <p>Add an active estate system before registering a connector.</p>
      )}
      {canManage && availableSystems.length > 0 && catalogue && (
        <section aria-label="Register connector" className="space-y-3 rounded border p-5">
          <h2 className="font-semibold">Register connector</h2>
          <MutationForm
            tenantId={tenantId}
            path="/connectors"
            method="POST"
            label="Create registration"
            body={(f) => ({
              systemId: f.get('systemId'),
              descriptorId: f.get('descriptorId'),
              name: f.get('name'),
              endpointRef: f.get('endpointRef'),
            })}
          >
            <label className="block">
              System
              <select name="systemId" className={inputClass} required>
                {availableSystems.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.estates.name} / {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Descriptor
              <select name="descriptorId" className={inputClass} required>
                {catalogue.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.target} {d.version} · {d.targetBinding}
                  </option>
                ))}
              </select>
            </label>
            <RegistrationFields />
          </MutationForm>
        </section>
      )}
      {connectors.length === 0 && (
        <DataPlaceholder title="No connectors registered in this tenant." />
      )}
      {connectors.map((row) => {
        const system = systems.find((s) => s.id === row.system_id);
        const descriptor = catalogue?.find((d) => d.id === row.descriptor_id);
        const latest = row.connector_health_checks[0];
        const parentActive = system?.status === 'active' && system.estates.status === 'active';
        return (
          <section
            key={`${row.id}:${row.version}`}
            aria-label={row.name}
            className="space-y-3 rounded border p-5"
          >
            <h2 className="font-semibold">{row.name}</h2>
            <p>
              {system?.estates.name} / {system?.name ?? 'System unavailable'} ·{' '}
              {row.status === 'active' ? 'Enabled registration' : row.status}
            </p>
            <p
              className={
                row.target_binding === 'production'
                  ? 'text-sm'
                  : 'rounded bg-amber-50 p-2 text-sm text-amber-900'
              }
            >
              {row.target_binding}
              {row.target_binding !== 'production' ? ' · Non-production; writes prohibited' : ''}
            </p>
            <p className="text-sm">
              Endpoint reference: {row.endpoint_ref} · Assurance policy: {row.assurance}
            </p>
            <p className="text-sm">
              Health: {latest ? `${latest.status} (recorded ${latest.checked_at})` : 'Not checked'}
            </p>
            <p className="text-sm">
              Descriptor:{' '}
              {descriptor ? `${descriptor.target} ${descriptor.version}` : row.descriptor_id}
            </p>
            <SetupStatus tenantId={tenantId} connectorId={row.id} />
            {canManage && row.status !== 'archived' && (
              <>
                {row.status !== 'active' && parentActive && (
                  <MutationForm
                    tenantId={tenantId}
                    path={`/connectors/${row.id}`}
                    method="PATCH"
                    label="Save registration"
                    body={(f) => ({
                      operation: 'edit',
                      expectedVersion: row.version,
                      name: f.get('name'),
                      endpointRef: f.get('endpointRef'),
                    })}
                  >
                    <RegistrationFields row={row} />
                  </MutationForm>
                )}
                <div className="flex gap-3">
                  {row.status !== 'active' && parentActive && descriptor && (
                    <MutationForm
                      tenantId={tenantId}
                      path={`/connectors/${row.id}`}
                      method="PATCH"
                      label="Enable registration"
                      body={() => ({
                        operation: 'transition',
                        expectedVersion: row.version,
                        status: 'active',
                      })}
                    >
                      <p className="text-sm">
                        Enable this registration without granting execution access.
                      </p>
                    </MutationForm>
                  )}
                  {row.status !== 'disabled' && (
                    <MutationForm
                      tenantId={tenantId}
                      path={`/connectors/${row.id}`}
                      method="PATCH"
                      label="Disable registration"
                      body={() => ({
                        operation: 'transition',
                        expectedVersion: row.version,
                        status: 'disabled',
                      })}
                    >
                      <p className="text-sm">Disabling revokes existing grants.</p>
                    </MutationForm>
                  )}
                  {row.status !== 'active' && (
                    <MutationForm
                      tenantId={tenantId}
                      path={`/connectors/${row.id}`}
                      method="PATCH"
                      label="Archive registration"
                      body={() => ({
                        operation: 'transition',
                        expectedVersion: row.version,
                        status: 'archived',
                      })}
                    >
                      <p className="text-sm">
                        Archival is final and revokes grants and stored credentials.
                      </p>
                    </MutationForm>
                  )}
                </div>
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
