'use client';
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import {
  CreateEstateRequestSchema,
  UpdateEstateRequestSchema,
  CreateEstateSystemRequestSchema,
  UpdateEstateSystemRequestSchema,
} from '@axiom/types';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  generateUUID,
} from '@axiom/ui';

export interface EstateRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'archived';
  version: number;
}
export interface SystemRow {
  id: string;
  estate_id: string;
  name: string;
  system_kind: string;
  description: string;
  external_ref: string | null;
  status: 'active' | 'archived';
  version: number;
  system_data_categories: { category_key: string; source: 'declared' | 'observed' }[];
}
export interface IntakeRow {
  id: string;
  title: string;
}
const fieldClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';
const validationIssues = z.array(
  z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  }),
);
const fieldLabels: Record<string, string> = {
  slug: 'Estate slug',
  name: 'Name',
  description: 'Description',
  systemKind: 'System kind',
  externalRef: 'External reference',
  dataCategories: 'Declared categories',
  status: 'Status',
  expectedVersion: 'Record version',
  estateId: 'Estate',
  confirmed: 'Scope confirmation',
};

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => {
    const field = fieldLabels[String(issue.path[0])] ?? 'Request fields';
    const item = typeof issue.path[1] === 'number' ? ` (item ${issue.path[1] + 1})` : '';
    return `${field}${item}: ${issue.message}`;
  });
}

/** Keeps the exact intent/key after a lost response. A retry cannot silently duplicate it. */
export function MutationForm({
  tenantId,
  path,
  method,
  body,
  children,
  label,
  onSuccess,
  schema,
}: {
  tenantId: string;
  path: string | ((form: FormData) => string);
  method: 'POST' | 'PATCH';
  body: (form: FormData) => Record<string, unknown>;
  children: ReactNode;
  label: string;
  onSuccess?: () => void;
  schema?: z.ZodType;
}) {
  const router = useRouter();
  const pending = useRef<{
    key: string;
    body: string;
    path: string;
    tenantId: string;
    method: 'POST' | 'PATCH';
  } | null>(null);
  const currentScope = useRef({ tenantId, method });
  useLayoutEffect(() => {
    currentScope.current = { tenantId, method };
  }, [tenantId, method]);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!pending.current) {
      try {
        const form = new FormData(event.currentTarget);
        const payload = body(form);
        const parsed = schema?.safeParse(payload);
        if (parsed && !parsed.success) {
          setMessage('Check the listed fields before saving.');
          setIssues(formatIssues(parsed.error.issues));
          return;
        }
        pending.current = {
          key: generateUUID(),
          body: JSON.stringify(parsed?.data ?? payload),
          path: typeof path === 'string' ? path : path(form),
          tenantId,
          method,
        };
      } catch {
        // No request exists yet. Keep the form editable; uncertainty applies
        // only once a prepared intent has actually been handed to transport.
        setUncertain(false);
        setIssues([]);
        setMessage(
          'The request could not be prepared. Nothing was sent. Check the form and try again.',
        );
        return;
      }
    }
    const attempt = pending.current;
    const sameScope = () =>
      currentScope.current.tenantId === attempt.tenantId &&
      currentScope.current.method === attempt.method;
    const scopeMessage =
      'Return to the original organisation and operation to resolve and retry this same request.';
    if (!sameScope()) {
      setUncertain(true);
      setMessage(scopeMessage);
      return;
    }
    setBusy(true);
    setMessage('');
    setIssues([]);
    try {
      const res = await fetch(`/api/bff/v1${attempt.path}`, {
        method: attempt.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': attempt.tenantId,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      const result = await res.json();
      if (!res.ok) {
        const ambiguous =
          res.status >= 500 || String(result.error?.code ?? '').startsWith('idempotency_');
        setUncertain(ambiguous);
        if (!ambiguous) pending.current = null;
        if (!sameScope()) {
          setMessage(
            ambiguous
              ? scopeMessage
              : 'The request in the original organisation or operation was refused. Return there to review it.',
          );
          return;
        }
        setMessage(result.error?.message ?? 'The request could not be completed.');
        const parsedIssues = validationIssues.safeParse(result.error?.issues);
        if (!ambiguous && parsedIssues.success) {
          setIssues(formatIssues(parsedIssues.data));
        }
        return;
      }
      if (!result?.data || typeof result.data.id !== 'string' || !result.data.id) {
        setUncertain(true);
        setMessage(
          sameScope()
            ? 'The server response did not identify the saved record. Retry the same request before making another change.'
            : scopeMessage,
        );
        return;
      }
      pending.current = null;
      setUncertain(false);
      if (!sameScope()) {
        setMessage(
          'The request in the original organisation or operation completed. Return there to review it.',
        );
        return;
      }
      setMessage('Saved.');
      try {
        formRef.current?.reset();
        onSuccess?.();
        router.refresh();
      } catch {
        // UI follow-up cannot turn a confirmed save into an unknown write.
        setMessage(
          'Saved. The page could not be refreshed; reload to review the confirmed record.',
        );
      }
    } catch {
      setUncertain(true);
      setMessage(
        sameScope()
          ? 'The result is unknown. Retry the same request before making another change.'
          : scopeMessage,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form ref={formRef} onSubmit={submit} className="space-y-3">
      <fieldset disabled={busy || uncertain} className="space-y-3">
        {children}
      </fieldset>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : uncertain ? 'Retry same request' : label}
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {issues.length > 0 && (
        <ul role="alert" className="text-sm text-destructive">
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {uncertain && <p className="text-sm">Keep this form open until the outcome is resolved.</p>}
    </form>
  );
}
function Field({
  label,
  name,
  value = '',
  required = false,
  maxLength = 4000,
  pattern,
  hint,
}: {
  label: string;
  name: string;
  value?: string;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        defaultValue={value}
        required={required}
        maxLength={maxLength}
        pattern={pattern}
        title={hint}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
function Status({ value }: { value: string }) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>Status</Label>
      <select id={id} name="status" defaultValue={value} className={fieldClass}>
        <option value="active">Active</option>
        <option value="archived">Archived</option>
      </select>
    </div>
  );
}
const text = (f: FormData, k: string) => String(f.get(k) ?? '');
function SystemForm({
  tenantId,
  estateId,
  system,
}: {
  tenantId: string;
  estateId: string;
  system?: SystemRow;
}) {
  const id = useId();
  return (
    <MutationForm
      tenantId={tenantId}
      path={system ? `/estate-systems/${system.id}` : `/estates/${estateId}/systems`}
      method={system ? 'PATCH' : 'POST'}
      label={system ? 'Save system' : 'Add system'}
      schema={system ? UpdateEstateSystemRequestSchema : CreateEstateSystemRequestSchema}
      body={(f) => ({
        name: text(f, 'name'),
        systemKind: text(f, 'systemKind'),
        description: text(f, 'description'),
        externalRef: text(f, 'externalRef') || null,
        dataCategories: text(f, 'dataCategories')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ...(system ? { status: text(f, 'status'), expectedVersion: system.version } : {}),
      })}
    >
      <Field label="System name" name="name" value={system?.name} required maxLength={200} />
      <div>
        <Label htmlFor={id}>System kind</Label>
        <select
          id={id}
          name="systemKind"
          defaultValue={system?.system_kind ?? 'database'}
          className={fieldClass}
        >
          {['database', 'application', 'storage', 'identity', 'saas', 'other'].map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>
      <Field label="Description" name="description" value={system?.description} />
      <Field
        label="External reference (no credentials)"
        name="externalRef"
        value={system?.external_ref ?? ''}
        maxLength={500}
      />
      <Field
        label="Declared categories (comma-separated lowercase keys)"
        maxLength={8198}
        hint="Enter up to 100 unique keys, each at most 80 characters, using lowercase letters, numbers and single hyphens. For example: identity, financial."
        name="dataCategories"
        value={system?.system_data_categories
          .filter((c) => c.source === 'declared')
          .map((c) => c.category_key)
          .join(', ')}
      />
      {system && <Status value={system.status} />}
    </MutationForm>
  );
}
export function EstateClient({
  tenantId,
  canManage,
  estates,
  systems,
  intakes,
}: {
  tenantId: string;
  canManage: boolean;
  estates: EstateRow[];
  systems: SystemRow[];
  intakes: IntakeRow[];
}) {
  return (
    <>
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Create estate</CardTitle>
          </CardHeader>
          <CardContent>
            <MutationForm
              tenantId={tenantId}
              path="/estates"
              method="POST"
              label="Create estate"
              schema={CreateEstateRequestSchema}
              body={(f) => ({
                name: text(f, 'name'),
                slug: text(f, 'slug'),
                description: text(f, 'description'),
              })}
            >
              <Field label="Estate name" name="name" required maxLength={200} />
              <Field
                label="Estate slug (lowercase words with hyphens)"
                name="slug"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                hint="Use lowercase letters and numbers separated by single hyphens, for example production-india."
                required
                maxLength={80}
              />
              <Field label="Description" name="description" />
            </MutationForm>
          </CardContent>
        </Card>
      )}
      {estates.length === 0 && (
        <p>No estates declared yet. A tenant owner or admin can create one.</p>
      )}
      {estates.map((estate) => (
        <Card key={`${estate.id}:${estate.version}`}>
          <CardHeader>
            <CardTitle>{estate.name}</CardTitle>
            <p className="text-sm">
              {estate.slug} · {estate.status}
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <p>{estate.description}</p>
            {canManage && (
              <details>
                <summary className="cursor-pointer">Edit estate</summary>
                <MutationForm
                  tenantId={tenantId}
                  path={`/estates/${estate.id}`}
                  method="PATCH"
                  label="Save estate"
                  schema={UpdateEstateRequestSchema}
                  body={(f) => ({
                    name: text(f, 'name'),
                    description: text(f, 'description'),
                    status: text(f, 'status'),
                    expectedVersion: estate.version,
                  })}
                >
                  <Field
                    label="Estate name"
                    name="name"
                    value={estate.name}
                    required
                    maxLength={200}
                  />
                  <Field label="Description" name="description" value={estate.description} />
                  <Status value={estate.status} />
                </MutationForm>
              </details>
            )}
            <h3 className="font-medium">Systems</h3>
            {systems
              .filter((s) => s.estate_id === estate.id)
              .map((s) => (
                <div key={`${s.id}:${s.version}`} className="rounded-md border p-4 space-y-2">
                  <h4 className="font-medium">{s.name}</h4>
                  <p className="text-sm">
                    {s.system_kind} · {s.status}
                  </p>
                  <p>{s.description}</p>
                  <p className="text-sm">
                    Declared:{' '}
                    {s.system_data_categories
                      .filter((c) => c.source === 'declared')
                      .map((c) => c.category_key)
                      .join(', ') || 'None'}
                  </p>
                  <p className="text-sm">
                    Observed:{' '}
                    {s.system_data_categories
                      .filter((c) => c.source === 'observed')
                      .map((c) => c.category_key)
                      .join(', ') || 'No observations'}
                  </p>
                  {canManage && estate.status === 'active' && (
                    <details>
                      <summary className="cursor-pointer">Edit system</summary>
                      <SystemForm tenantId={tenantId} estateId={estate.id} system={s} />
                    </details>
                  )}
                </div>
              ))}
            {systems.every((s) => s.estate_id !== estate.id) && <p>No systems declared.</p>}
            {canManage && estate.status === 'active' && (
              <>
                <details>
                  <summary className="cursor-pointer">Add a system</summary>
                  <SystemForm tenantId={tenantId} estateId={estate.id} />
                </details>
                {intakes.length > 0 && (
                  <details>
                    <summary className="cursor-pointer">Assign an unassigned assessment</summary>
                    <p className="text-sm">
                      Only intake assessments with no recorded work can be assigned. Existing
                      assessment history cannot be moved.
                    </p>
                    <Assignment tenantId={tenantId} estateId={estate.id} intakes={intakes} />
                  </details>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </>
  );
}
function Assignment({
  tenantId,
  estateId,
  intakes,
}: {
  tenantId: string;
  estateId: string;
  intakes: IntakeRow[];
}) {
  const id = useId();
  return (
    <MutationForm
      tenantId={tenantId}
      path={(f) => `/engagements/${text(f, 'assessment')}/estate`}
      method="POST"
      label="Assign assessment"
      body={() => ({ estateId, confirmed: true })}
    >
      <Label htmlFor={id}>Assessment</Label>
      <select id={id} name="assessment" className={fieldClass}>
        {intakes.map((i) => (
          <option value={i.id} key={i.id}>
            {i.title}
          </option>
        ))}
      </select>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" required /> I confirm that this estate is the intended assessment
        scope.
      </label>
    </MutationForm>
  );
}
