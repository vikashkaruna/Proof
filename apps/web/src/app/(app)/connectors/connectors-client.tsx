'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ConnectorManifestSchema, type ConnectorManifest } from '@axiom/types';
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
      <Link href="/estate" className="text-teal-700 underline">
        Manage estate inventory
      </Link>
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
      {connectors.length === 0 && <p>No connectors registered in this tenant.</p>}
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
