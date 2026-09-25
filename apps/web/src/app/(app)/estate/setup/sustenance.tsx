'use client';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@axiom/ui';
import type { EstateDrift, GrantReviewItem } from '@axiom/types';
import { MutationForm } from '../estate-client';

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: T };

async function get<T>(tenantId: string, path: string): Promise<Load<T>> {
  try {
    const res = await fetch(`/api/bff/v1${path}`, {
      headers: { 'X-Tenant-Id': tenantId },
      cache: 'no-store',
    });
    if (!res.ok) return { state: 'error' };
    return { state: 'ready', data: ((await res.json()) as { data: T }).data };
  } catch {
    return { state: 'error' };
  }
}

function useBff<T>(tenantId: string, path: string, revision: number): Load<T> {
  const [loaded, setLoaded] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    if (!path) return;
    let active = true;
    void get<T>(tenantId, path).then((result) => {
      if (active) setLoaded(result);
    });
    return () => {
      active = false;
    };
  }, [tenantId, path, revision]);
  return loaded;
}

const DRIFT_GROUPS = [
  ['added', 'Systems added since onboarding'],
  ['removed', 'Onboarded systems archived or moved'],
  ['changed', 'Systems changed since onboarding'],
  ['connectionLost', 'Systems that lost their connection path'],
] as const;

/** Drift of an estate against its last completed onboarding (C-W3-6). */
export function DriftCard({ tenantId, estateId }: { tenantId: string; estateId: string }) {
  const drift = useBff<EstateDrift>(tenantId, `/estates/${estateId}/drift`, 0);
  return (
    <Card data-testid="estate-drift">
      <CardHeader>
        <CardTitle>Changes since onboarding</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {drift.state === 'loading' ? (
          <p role="status">Checking the estate…</p>
        ) : drift.state === 'error' ? (
          <p role="alert">Drift could not be checked. Refresh to try again.</p>
        ) : drift.data.status === 'current' ? (
          <p data-testid="drift-status">No changes since the last onboarding.</p>
        ) : drift.data.status === 'drifted' ? (
          <>
            <p data-testid="drift-status">
              The estate has changed since the last onboarding. Start re-onboarding to review and
              re-confirm it.
            </p>
            {DRIFT_GROUPS.map(([key, label]) =>
              drift.data[key]?.length ? (
                <div key={key} data-testid={`drift-${key}`}>
                  <p className="font-semibold">{label}</p>
                  <ul>
                    {drift.data[key]!.map((s) => (
                      <li key={s.id}>{s.name}</li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </>
        ) : (
          <p data-testid="drift-status">
            No onboarding baseline was recorded for this estate, so drift cannot be computed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Periodic human review of agent connector grants (C-W3-6). */
export interface GrantTargets {
  connectors: { id: string; name: string }[];
  workloads: { id: string; agentName: string; spiffeId: string }[];
}
const fieldClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';

export function GrantReview({
  tenantId,
  canManage,
  targets,
}: {
  tenantId: string;
  canManage: boolean;
  targets: GrantTargets;
}) {
  const [revision, setRevision] = useState(0);
  const queue = useBff<GrantReviewItem[]>(tenantId, '/connector-grants/review', revision);
  return (
    <Card data-testid="grant-review">
      <CardHeader>
        <CardTitle>Agent access review</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {canManage && (
          <details className="mb-4" data-testid="issue-grant">
            <summary className="cursor-pointer font-semibold">Issue agent access</summary>
            {targets.connectors.length === 0 || targets.workloads.length === 0 ? (
              <p>
                Issuing access needs an enabled connector and an active Drishti or Karya workload
                identity.
              </p>
            ) : (
              <MutationForm
                tenantId={tenantId}
                path="/connector-grants"
                method="POST"
                label="Issue access"
                onSuccess={() => setRevision((n) => n + 1)}
                body={(f) => {
                  const workload = targets.workloads.find((w) => w.id === f.get('workload'));
                  return {
                    connectorId: String(f.get('connector') ?? ''),
                    workloadIdentityId: String(f.get('workload') ?? ''),
                    scope: workload?.agentName === 'karya' ? 'connector.write' : 'connector.read',
                    targetScopes: String(f.get('targetScopes') ?? '')
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                    ttlDays: Number(f.get('ttlDays') ?? 30),
                  };
                }}
              >
                <label className="flex flex-col gap-1">
                  Connector
                  <select name="connector" required className={fieldClass}>
                    {targets.connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Agent workload
                  <select name="workload" required className={fieldClass}>
                    {targets.workloads.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.agentName === 'karya' ? 'Karya (write)' : 'Drishti (read)'} ·{' '}
                        {w.spiffeId}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Target scopes (comma separated)
                  <input name="targetScopes" required className={fieldClass} />
                </label>
                <label className="flex flex-col gap-1">
                  Valid for (days, at most 90)
                  <input
                    name="ttlDays"
                    type="number"
                    min={1}
                    max={90}
                    defaultValue={30}
                    required
                    className={fieldClass}
                  />
                </label>
                <p>
                  Issuing records authority only. It obtains no credential and contacts no system;
                  the broker re-checks the grant on every use.
                </p>
              </MutationForm>
            )}
          </details>
        )}
        {queue.state === 'loading' ? (
          <p role="status">Loading agent grants…</p>
        ) : queue.state === 'error' ? (
          <p role="alert">Agent grants could not be loaded. Refresh to try again.</p>
        ) : queue.data.length === 0 ? (
          <p>No active agent grants to review.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {queue.data.map((g) => (
              <li key={g.id} data-testid={`grant-${g.id}`}>
                <p>
                  {g.agentName} · {g.scope === 'connector.write' ? 'write' : 'read'} ·{' '}
                  {g.connectorName} · review {g.overdue ? 'overdue since' : 'due'}{' '}
                  {new Date(g.dueAt).toLocaleDateString()} · expires{' '}
                  {new Date(g.expiresAt).toLocaleDateString()}
                </p>
                {canManage && (
                  <div className="flex gap-3">
                    {(['keep', 'revoke'] as const).map((decision) => (
                      <MutationForm
                        key={decision}
                        tenantId={tenantId}
                        path={`/connector-grants/${g.id}/attestations`}
                        method="POST"
                        label={decision === 'keep' ? 'Keep access' : 'Revoke access'}
                        body={() => ({ decision })}
                        onSuccess={() => setRevision((n) => n + 1)}
                      >
                        {null}
                      </MutationForm>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type RegisteredTool = {
  id: string;
  tool_name: string;
  tool_version: string;
  operation_class: 'read' | 'write';
  description_sha256: string;
  created_at: string;
};

/** W4.5 internal tool registry: registered tools per connector and an
 * append-only registration form. Registering authorizes nothing by itself. */
export function ToolRegistry({
  tenantId,
  canManage,
  connectors,
}: {
  tenantId: string;
  canManage: boolean;
  connectors: { id: string; name: string }[];
}) {
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? '');
  const [revision, setRevision] = useState(0);
  const tools = useBff<RegisteredTool[]>(
    tenantId,
    connectorId ? `/connectors/${connectorId}/tools` : '',
    revision,
  );
  return (
    <Card data-testid="tool-registry">
      <CardHeader>
        <CardTitle>Connector tools</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {connectors.length === 0 ? (
          <p>No active connectors. Register a connector before its tools.</p>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              Connector
              <select
                aria-label="Tool connector"
                value={connectorId}
                onChange={(e) => setConnectorId(e.target.value)}
                className={fieldClass}
              >
                {connectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {tools.state === 'loading' ? (
              <p role="status">Loading tools…</p>
            ) : tools.state === 'error' ? (
              <p role="alert">Tools could not be loaded. Refresh to try again.</p>
            ) : tools.data.length === 0 ? (
              <p>No tools registered for this connector.</p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Registered tools">
                {tools.data.map((t) => (
                  <li key={t.id}>
                    <span className="font-medium">
                      {t.tool_name}@{t.tool_version}
                    </span>{' '}
                    · {t.operation_class === 'write' ? 'write' : 'read'} · pinned{' '}
                    <code>{t.description_sha256.slice(0, 12)}</code>
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <details>
                <summary>Register a tool version</summary>
                <MutationForm
                  tenantId={tenantId}
                  path={`/connectors/${connectorId}/tools`}
                  method="POST"
                  label="Register tool"
                  onSuccess={() => setRevision((n) => n + 1)}
                  body={(f) => ({
                    toolName: String(f.get('toolName') ?? ''),
                    toolVersion: String(f.get('toolVersion') ?? ''),
                    operationClass: String(f.get('operationClass') ?? 'read'),
                    description: String(f.get('description') ?? ''),
                    inputSchema: { type: 'object' },
                  })}
                >
                  <label className="flex flex-col gap-1">
                    Tool name
                    <input name="toolName" required className={fieldClass} />
                  </label>
                  <label className="flex flex-col gap-1">
                    Version
                    <input name="toolVersion" required className={fieldClass} />
                  </label>
                  <label className="flex flex-col gap-1">
                    Class
                    <select name="operationClass" className={fieldClass}>
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    Description (pinned by hash)
                    <textarea name="description" required maxLength={4000} className={fieldClass} />
                  </label>
                  <p>
                    A registered version cannot be changed. Using a tool still needs a live grant
                    whose scope matches its class.
                  </p>
                </MutationForm>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
