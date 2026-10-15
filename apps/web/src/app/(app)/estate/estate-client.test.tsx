// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EstateClient, MutationForm } from './estate-client';
import { CreateEstateRequestSchema } from '@axiom/types';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const onSuccess = vi.fn();
const show = () =>
  render(
    <MutationForm
      tenantId="tenant-1"
      path="/estates"
      method="POST"
      label="Save estate"
      body={(form) => ({ name: String(form.get('name')) })}
      onSuccess={onSuccess}
    >
      <label>
        Estate name
        <input name="name" defaultValue="Alpha" />
      </label>
    </MutationForm>,
  );

beforeEach(() => {
  refresh.mockReset();
  onSuccess.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps an ambiguous mutation frozen and retries with the exact same body and key', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText(/result is unknown/)).toBeTruthy());
  expect(screen.getByLabelText('Estate name').closest('fieldset')?.hasAttribute('disabled')).toBe(
    true,
  );
  expect(onSuccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe(
    fetcher.mock.calls[1]![1].headers['Idempotency-Key'],
  );
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({
    method: 'POST',
    headers: { 'X-Tenant-Id': 'tenant-1' },
  });
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it('clears a rejected client request so a corrected submission can get a new key', async () => {
  let key = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++key}` });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid estate' } }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText('Invalid estate')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Estate name'), { target: { value: 'Corrected' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe('request-2');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ name: 'Corrected' });
});

it('treats an idempotency conflict as uncertain rather than issuing a new mutation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'idempotency_conflict', message: 'Conflict' } },
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() =>
    expect(screen.getByText('Keep this form open until the outcome is resolved.')).toBeTruthy(),
  );
  expect(onSuccess).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it('keeps an HTTP success without a saved identity uncertain and retries the same operation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: {} }))
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText(/did not identify the saved record/)).toBeTruthy());
  expect(onSuccess).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe(
    fetcher.mock.calls[1]![1].headers['Idempotency-Key'],
  );
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
});

it('shows a viewer only recorded estate systems and distinguishes declared from observed categories', () => {
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage={false}
      intakes={[]}
      estates={[
        {
          id: 'estate-1',
          name: 'Production estate',
          slug: 'production',
          description: 'Verified client boundary',
          status: 'active',
          version: 1,
        },
      ]}
      systems={[
        {
          id: 'system-1',
          estate_id: 'estate-1',
          name: 'Payroll',
          system_kind: 'postgres',
          description: 'Client declared database',
          external_ref: null,
          status: 'active',
          version: 1,
          system_data_categories: [
            { category_key: 'identity', source: 'declared' },
            { category_key: 'financial', source: 'observed' },
          ],
        },
      ]}
    />,
  );
  expect(document.body.textContent).toContain('Production estate');
  expect(document.body.textContent).toContain('Payroll');
  expect(document.body.textContent).toContain('Declared: identity');
  expect(document.body.textContent).toContain('Observed: financial');
  expect(screen.queryByText('Create estate')).toBeNull();
  expect(screen.queryByText('Edit system')).toBeNull();
});

it('shows an empty estate without inventing systems or assessments', () => {
  render(<EstateClient tenantId="tenant-1" canManage estates={[]} systems={[]} intakes={[]} />);
  expect(
    screen.getByText('No estates declared yet. A tenant owner or admin can create one.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create estate' })).toBeTruthy();
  expect(document.body.textContent).not.toContain('production-core-postgres');
});

it('saves an estate edit with its recorded version and tenant-bound request', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'estate-1' } }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage
      estates={[
        {
          id: 'estate-1',
          name: 'Actual estate',
          slug: 'actual',
          description: 'Recorded scope',
          status: 'active',
          version: 4,
        },
      ]}
      systems={[]}
      intakes={[]}
    />,
  );
  fireEvent.click(screen.getByText('Edit estate'));
  fireEvent.change(
    screen.getByLabelText('Estate name', { selector: 'input[value="Actual estate"]' }),
    { target: { value: 'Reviewed estate' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/bff/v1/estates/estate-1');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: 'PATCH',
    headers: { 'X-Tenant-Id': 'tenant-1' },
  });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
    name: 'Reviewed estate',
    expectedVersion: 4,
    status: 'active',
  });
});

it('requires an explicit scope confirmation before assigning an intake assessment', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'intake-1' } }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage
      estates={[
        {
          id: 'estate-1',
          name: 'Actual estate',
          slug: 'actual',
          description: '',
          status: 'active',
          version: 1,
        },
      ]}
      systems={[]}
      intakes={[{ id: 'intake-1', title: 'Unassigned assessment' }]}
    />,
  );
  fireEvent.click(screen.getByText('Assign an unassigned assessment'));
  const button = screen.getByRole('button', { name: 'Assign assessment' });
  fireEvent.click(button);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByLabelText(/I confirm that this estate is the intended assessment scope/),
  );
  fireEvent.click(button);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/bff/v1/engagements/intake-1/estate');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    estateId: 'estate-1',
    confirmed: true,
  });
});

it('does not offer an archived estate new system or assessment mutations', () => {
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage
      estates={[
        {
          id: 'estate-1',
          name: 'Archived estate',
          slug: 'archived',
          description: '',
          status: 'archived',
          version: 2,
        },
      ]}
      systems={[]}
      intakes={[{ id: 'intake-1', title: 'Unassigned assessment' }]}
    />,
  );
  expect(screen.queryByText('Add a system')).toBeNull();
  expect(screen.queryByText('Assign an unassigned assessment')).toBeNull();
  expect(screen.getByText('Archived estate')).toBeTruthy();
});

it('explains a rejected estate field and saves the corrected request without losing tenant scope', async () => {
  let key = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++key}` });
  const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const parsed = CreateEstateRequestSchema.safeParse(JSON.parse(String(init.body)));
    return parsed.success
      ? Response.json({ data: { id: 'estate-1', ...parsed.data } }, { status: 201 })
      : Response.json(
          {
            error: {
              code: 'invalid_request',
              message: 'Check the supplied estate fields.',
              issues: parsed.error.issues,
            },
          },
          { status: 400 },
        );
  });
  vi.stubGlobal('fetch', fetcher);
  render(<EstateClient tenantId="tenant-1" canManage estates={[]} systems={[]} intakes={[]} />);
  fireEvent.change(screen.getByLabelText('Estate name'), { target: { value: 'Client Estate' } });
  const slug = screen.getByLabelText(
    'Estate slug (lowercase words with hyphens)',
  ) as HTMLInputElement;
  fireEvent.change(slug, { target: { value: 'Client Estate' } });
  expect(slug.checkValidity()).toBe(false);
  expect(slug.getAttribute('aria-describedby')).toBeTruthy();
  // Exercise schema validation even when native browser validation is bypassed.
  fireEvent.submit(slug.closest('form')!);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Estate slug: Use lowercase'),
  );
  expect((screen.getByLabelText('Estate name') as HTMLInputElement).value).toBe('Client Estate');
  expect(refresh).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(slug, { target: { value: 'client-estate' } });
  expect(slug.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Create estate' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': 'request-1',
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it('rejects a whitespace-only estate name locally and preserves fields for correction', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'estate-1' } }));
  vi.stubGlobal('fetch', fetcher);
  render(<EstateClient tenantId="tenant-1" canManage estates={[]} systems={[]} intakes={[]} />);
  const name = screen.getByLabelText('Estate name');
  const slug = screen.getByLabelText('Estate slug (lowercase words with hyphens)');
  fireEvent.change(name, { target: { value: '   ' } });
  fireEvent.change(slug, { target: { value: 'client-estate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create estate' }));
  expect(screen.getByRole('alert').textContent).toContain('Name:');
  expect(fetcher).not.toHaveBeenCalled();
  expect((slug as HTMLInputElement).value).toBe('client-estate');
  fireEvent.change(name, { target: { value: '  Client Estate  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create estate' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    name: 'Client Estate',
    slug: 'client-estate',
    description: '',
  });
});

it('validates system categories locally and saves the corrected inventory without dropping inputs', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'system-1' } }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage
      intakes={[]}
      systems={[]}
      estates={[
        {
          id: 'estate-1',
          name: 'Client Estate',
          slug: 'client-estate',
          description: '',
          status: 'active',
          version: 1,
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByText('Add a system'));
  fireEvent.change(screen.getByLabelText('System name'), { target: { value: '  Payroll  ' } });
  const categories = screen.getByLabelText('Declared categories (comma-separated lowercase keys)');
  expect(categories.getAttribute('maxlength')).toBe('8198');
  fireEvent.change(categories, { target: { value: 'identity, Health Data' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
  expect(screen.getByRole('alert').textContent).toContain('Declared categories (item 2):');
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(categories, { target: { value: 'identity, identity' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
  expect(screen.getByRole('alert').textContent).toContain('Duplicate categories');
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(categories, { target: { value: 'identity, health-data' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/bff/v1/estates/estate-1/systems');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    name: 'Payroll',
    systemKind: 'database',
    externalRef: null,
    description: '',
    dataCategories: ['identity', 'health-data'],
  });
});

it('shows server field errors too and lets a rejected request be corrected', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Check the supplied estate fields.',
          issues: [{ path: ['name'], message: 'Use a shorter name.' }],
        },
      },
      { status: 400 },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Name: Use a shorter name.'),
  );
  expect(screen.getByLabelText('Estate name').closest('fieldset')?.disabled).toBe(false);
  expect(onSuccess).not.toHaveBeenCalled();
});

it('retries a schema-validated uncertain intent without revalidating changed fields or props', async () => {
  const uuid = vi.fn(() => 'request-schema-1');
  vi.stubGlobal('crypto', { randomUUID: uuid });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'estate_unavailable', message: 'Unknown save result' } },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const originalBody = vi.fn((form: FormData) => ({
    name: String(form.get('name')),
    slug: String(form.get('slug')),
  }));
  const replacementBody = vi.fn(() => ({ name: '', slug: 'INVALID' }));
  const replacementPath = vi.fn(() => '/estates/replacement');
  const form = (
    path: string | ((data: FormData) => string),
    body: (data: FormData) => Record<string, unknown>,
  ) => (
    <MutationForm
      tenantId="tenant-1"
      path={path}
      method="POST"
      label="Create estate"
      schema={CreateEstateRequestSchema}
      body={body}
      onSuccess={onSuccess}
    >
      <label>
        Estate name
        <input name="name" defaultValue="  Reviewed Estate  " />
      </label>
      <label>
        Estate slug
        <input name="slug" defaultValue="reviewed-estate" />
      </label>
    </MutationForm>
  );
  const view = render(form('/estates', originalBody));
  fireEvent.click(screen.getByRole('button', { name: 'Create estate' }));
  await waitFor(() => expect(screen.getByText('Unknown save result')).toBeTruthy());
  const first = fetcher.mock.calls[0]!;
  expect(JSON.parse(first[1].body)).toEqual({
    name: 'Reviewed Estate',
    slug: 'reviewed-estate',
    description: '',
  });
  expect(screen.getByLabelText('Estate name').closest('fieldset')?.disabled).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(form(replacementPath, replacementBody));
  // Programmatically alter disabled DOM fields: an uncertain retry must use the
  // original serialized intent even if current form values no longer validate.
  fireEvent.change(screen.getByLabelText('Estate name'), { target: { value: '   ' } });
  fireEvent.change(screen.getByLabelText('Estate slug'), { target: { value: 'INVALID' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![0]).toBe(first[0]);
  expect(fetcher.mock.calls[1]![1]).toEqual(first[1]);
  expect(fetcher.mock.calls[1]![0]).toBe('/api/bff/v1/estates');
  expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': 'request-schema-1',
  });
  expect(originalBody).toHaveBeenCalledOnce();
  expect(replacementBody).not.toHaveBeenCalled();
  expect(replacementPath).not.toHaveBeenCalled();
  expect(uuid).toHaveBeenCalledOnce();
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it('corrects a definitely rejected system edit with a fresh key and its original expected version', async () => {
  let key = 0;
  const uuid = vi.fn(() => `system-edit-${++key}`);
  vi.stubGlobal('crypto', { randomUUID: uuid });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Review external reference.',
            issues: [{ path: ['externalRef'], message: 'Use the reviewed reference.' }],
          },
        },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ data: { id: 'system-1' } }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <EstateClient
      tenantId="tenant-1"
      canManage
      intakes={[]}
      estates={[
        {
          id: 'estate-1',
          name: 'Client Estate',
          slug: 'client-estate',
          description: '',
          status: 'active',
          version: 3,
        },
      ]}
      systems={[
        {
          id: 'system-1',
          estate_id: 'estate-1',
          name: 'Payroll',
          system_kind: 'database',
          external_ref: 'old-reference',
          description: 'Retained description',
          status: 'active',
          version: 7,
          system_data_categories: [{ category_key: 'identity', source: 'declared' }],
        },
      ]}
    />,
  );
  const summary = screen.getByText('Edit system');
  fireEvent.click(summary);
  const editor = within(summary.closest('details')!);
  fireEvent.change(editor.getByLabelText('System name'), { target: { value: '   ' } });
  fireEvent.click(editor.getByRole('button', { name: 'Save system' }));
  expect(editor.getByRole('alert').textContent).toContain('Name:');
  expect(fetcher).not.toHaveBeenCalled();
  expect(uuid).not.toHaveBeenCalled();
  fireEvent.change(editor.getByLabelText('System name'), {
    target: { value: '  Reviewed Payroll  ' },
  });
  fireEvent.click(editor.getByRole('button', { name: 'Save system' }));
  await waitFor(() =>
    expect(editor.getByRole('alert').textContent).toContain(
      'External reference: Use the reviewed reference.',
    ),
  );
  expect(editor.getByLabelText('System name').closest('fieldset')?.disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  expect((editor.getByLabelText('System name') as HTMLInputElement).value).toBe(
    '  Reviewed Payroll  ',
  );
  expect((editor.getByLabelText('Description') as HTMLInputElement).value).toBe(
    'Retained description',
  );
  fireEvent.change(editor.getByLabelText('External reference (no credentials)'), {
    target: { value: 'reviewed-reference' },
  });
  fireEvent.click(editor.getByRole('button', { name: 'Save system' }));
  await waitFor(() => expect(editor.getByText('Saved.')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const call of fetcher.mock.calls) {
    expect(call[0]).toBe('/api/bff/v1/estate-systems/system-1');
    expect(call[1]).toMatchObject({ method: 'PATCH', headers: { 'X-Tenant-Id': 'tenant-1' } });
    expect(JSON.parse(call[1].body)).toMatchObject({
      name: 'Reviewed Payroll',
      description: 'Retained description',
      systemKind: 'database',
      status: 'active',
      expectedVersion: 7,
      dataCategories: ['identity'],
    });
  }
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe('system-edit-1');
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe('system-edit-2');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).externalRef).toBe('old-reference');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).externalRef).toBe('reviewed-reference');
  expect(editor.queryByRole('alert')).toBeNull();
  expect(uuid).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
});

it.each(['estate', 'system'])(
  'saves a real %s form on HTTP with CSPRNG fallback and retains the key on uncertain retry',
  async (kind) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(23);
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(Response.json({ data: { id: `${kind}-1` } }));
    vi.stubGlobal('fetch', fetcher);
    render(
      <EstateClient
        tenantId="tenant-1"
        canManage
        intakes={[]}
        systems={[]}
        estates={
          kind === 'system'
            ? [
                {
                  id: 'estate-1',
                  name: 'Client Estate',
                  slug: 'client-estate',
                  description: '',
                  status: 'active',
                  version: 1,
                },
              ]
            : []
        }
      />,
    );
    const scope =
      kind === 'system' ? within(screen.getByText('Add a system').closest('details')!) : screen;
    if (kind === 'system') {
      fireEvent.click(screen.getByText('Add a system'));
      fireEvent.change(scope.getByLabelText('System name'), { target: { value: 'Payroll' } });
      fireEvent.change(
        scope.getByLabelText('Declared categories (comma-separated lowercase keys)'),
        { target: { value: 'identity' } },
      );
    } else {
      fireEvent.change(scope.getByLabelText('Estate name'), { target: { value: 'Client Estate' } });
      fireEvent.change(scope.getByLabelText('Estate slug (lowercase words with hyphens)'), {
        target: { value: 'client-estate' },
      });
    }
    fireEvent.click(
      scope.getByRole('button', { name: kind === 'system' ? 'Add system' : 'Create estate' }),
    );
    await waitFor(() => expect(scope.getByText(/result is unknown/)).toBeTruthy());
    fireEvent.click(scope.getByRole('button', { name: 'Retry same request' }));
    await waitFor(() => expect(scope.getByText('Saved.')).toBeTruthy());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
    expect(fetcher.mock.calls[0]![0]).toBe(
      kind === 'system' ? '/api/bff/v1/estates/estate-1/systems' : '/api/bff/v1/estates',
    );
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
      'X-Tenant-Id': 'tenant-1',
      'Idempotency-Key': expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    });
    expect(getRandomValues).toHaveBeenCalledOnce();
  },
);

it.each(['rng', 'body', 'path'])(
  'reports a never-sent %s preparation failure without freezing the form',
  async (failure) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'estate-1' } }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('crypto', failure === 'rng' ? {} : { randomUUID: () => 'request-prepared' });
    let fail = true;
    const view = render(
      <MutationForm
        tenantId="tenant-1"
        path={() => {
          if (fail && failure === 'path') throw new Error('private-path-detail');
          return '/estates';
        }}
        method="POST"
        label="Save estate"
        body={(form) => {
          if (fail && failure === 'body') throw new Error('private-body-detail');
          return { name: String(form.get('name')) };
        }}
      >
        <label>
          Estate name
          <input name="name" defaultValue="Alpha" />
        </label>
      </MutationForm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('could not be prepared'),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private-');
    expect(screen.getByLabelText('Estate name').closest('fieldset')?.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    expect(screen.queryByText(/Keep this form open/)).toBeNull();
    fail = false;
    vi.stubGlobal('crypto', { randomUUID: () => 'request-prepared' });
    fireEvent.change(screen.getByLabelText('Estate name'), { target: { value: 'Corrected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ name: 'Corrected' });
    view.unmount();
  },
);

it.each(['tenant', 'method'])(
  'retains an uncertain intent but refuses replay under a changed %s',
  async (change) => {
    const uuid = vi.fn(() => 'scope-request-1');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(Response.json({ data: { id: 'estate-original' } }));
    vi.stubGlobal('fetch', fetcher);
    const form = (tenantId: string, method: 'POST' | 'PATCH') => (
      <MutationForm
        tenantId={tenantId}
        method={method}
        path="/estates"
        label="Save scoped estate"
        body={(data) => ({ name: String(data.get('name')) })}
      >
        <label>
          Scoped name
          <input name="name" defaultValue="Original intent" />
        </label>
      </MutationForm>
    );
    const view = render(form('tenant-A', 'POST'));
    fireEvent.click(screen.getByRole('button', { name: 'Save scoped estate' }));
    await screen.findByText(/result is unknown/);
    const first = fetcher.mock.calls[0]!;
    view.rerender(
      form(change === 'tenant' ? 'tenant-B' : 'tenant-A', change === 'method' ? 'PATCH' : 'POST'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await screen.findByText(/Return to the original organisation and operation/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(uuid).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Scoped name').closest('fieldset')?.disabled).toBe(true);
    view.rerender(form('tenant-A', 'POST'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await screen.findByText('Saved.');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual(first);
    expect(uuid).toHaveBeenCalledOnce();
  },
);

it('allows a fresh organisation and method only after a definite refusal clears the old intent', async () => {
  let counter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `scope-new-${++counter}` });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { message: 'Definitely refused' } }, { status: 400 }),
    )
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-B' } }));
  vi.stubGlobal('fetch', fetcher);
  const form = (tenantId: string, method: 'POST' | 'PATCH') => (
    <MutationForm
      tenantId={tenantId}
      method={method}
      path="/estates"
      label="Save scoped estate"
      body={() => ({ name: tenantId })}
    >
      <input name="name" />
    </MutationForm>
  );
  const view = render(form('tenant-A', 'POST'));
  fireEvent.click(screen.getByRole('button', { name: 'Save scoped estate' }));
  await screen.findByText('Definitely refused');
  view.rerender(form('tenant-B', 'PATCH'));
  fireEvent.click(screen.getByRole('button', { name: 'Save scoped estate' }));
  await screen.findByText('Saved.');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({
    method: 'PATCH',
    headers: { 'X-Tenant-Id': 'tenant-B', 'Idempotency-Key': 'scope-new-2' },
  });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ name: 'tenant-B' });
});

it.each(['tenant', 'method'])(
  'does not reset or invoke success callbacks in a changed %s after an old success settles',
  async (change) => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn().mockReturnValue(response);
    vi.stubGlobal('fetch', fetcher);
    const originalSuccess = vi.fn();
    const nextSuccess = vi.fn();
    const form = (tenantId: string, method: 'POST' | 'PATCH', success: () => void) => (
      <MutationForm
        tenantId={tenantId}
        method={method}
        path="/estates"
        label="Save scoped estate"
        body={(data) => ({ name: String(data.get('name')) })}
        onSuccess={success}
      >
        <label>
          Scoped name
          <input name="name" defaultValue="Original intent" />
        </label>
      </MutationForm>
    );
    const view = render(form('tenant-A', 'POST', originalSuccess));
    fireEvent.click(screen.getByRole('button', { name: 'Save scoped estate' }));
    expect(fetcher).toHaveBeenCalledOnce();
    view.rerender(
      form(
        change === 'tenant' ? 'tenant-B' : 'tenant-A',
        change === 'method' ? 'PATCH' : 'POST',
        nextSuccess,
      ),
    );
    fireEvent.change(screen.getByLabelText('Scoped name'), {
      target: { value: 'New scope input' },
    });
    await act(async () => {
      finish(Response.json({ data: { id: 'estate-A' } }));
    });
    await screen.findByText(/original organisation or operation completed/);
    expect((screen.getByLabelText('Scoped name') as HTMLInputElement).value).toBe(
      'New scope input',
    );
    expect(originalSuccess).not.toHaveBeenCalled();
    expect(nextSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
  },
);

it.each(['response', 'network', 'malformed'])(
  'retains a %s outcome that becomes unknown after the organisation changes',
  async (outcome) => {
    let finish!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const response = new Promise<Response>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockResolvedValueOnce(Response.json({ data: { id: 'estate-A' } }));
    vi.stubGlobal('fetch', fetcher);
    const uuid = vi.fn(() => 'deferred-scope-key');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    const form = (tenantId: string) => (
      <MutationForm
        tenantId={tenantId}
        method="POST"
        path="/estates"
        label="Save scoped estate"
        body={() => ({ name: 'Original' })}
        onSuccess={onSuccess}
      >
        <input name="name" />
      </MutationForm>
    );
    const view = render(form('tenant-A'));
    fireEvent.click(screen.getByRole('button', { name: 'Save scoped estate' }));
    const first = fetcher.mock.calls[0]!;
    view.rerender(form('tenant-B'));
    await act(async () => {
      if (outcome === 'network') fail(new Error('private-network-detail'));
      else
        finish(
          outcome === 'response'
            ? Response.json({ error: { code: 'unknown' } }, { status: 503 })
            : Response.json({ data: {} }),
        );
    });
    await screen.findByText(/Return to the original organisation and operation/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(fetcher).toHaveBeenCalledOnce();
    view.rerender(form('tenant-A'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await screen.findByText('Saved.');
    expect(fetcher.mock.calls[1]).toEqual(first);
    expect(uuid).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
  },
);

it.each(['callback', 'refresh'])(
  'keeps a confirmed save settled when its %s UI follow-up throws',
  async (failure) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: 'saved-estate' } }));
    vi.stubGlobal('fetch', fetcher);
    const uuid = vi.fn(() => 'confirmed-save-key');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    if (failure === 'callback')
      onSuccess.mockImplementation(() => {
        throw new Error('private-callback-detail');
      });
    else
      refresh.mockImplementation(() => {
        throw new Error('private-refresh-detail');
      });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
    await screen.findByText(/Saved.*reload to review/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(uuid).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    expect(screen.queryByText(/Keep this form open/)).toBeNull();
    expect(screen.getByLabelText('Estate name').closest('fieldset')?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('private-');
  },
);
