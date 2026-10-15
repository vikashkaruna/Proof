// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateAssessmentForm } from './create-assessment-form';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CREATED = '22222222-2222-4222-8222-222222222222';
const ESTATE = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => REQUEST });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function form() {
  const view = render(
    <CreateAssessmentForm
      tenantId={TENANT}
      libraryVersion="0.1.1"
      estates={[{ id: ESTATE, name: 'Primary estate' }]}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Assessment title' }), {
    target: { value: 'October review' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Assessment estate (optional)' }), {
    target: { value: ESTATE },
  });
  return view;
}

it('does not permit a native submit before hydration', () => {
  const html = renderToString(
    <CreateAssessmentForm tenantId={TENANT} libraryVersion="0.1.1" estates={[]} />,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create assessment<\/button>/);
});

it('creates a scoped assessment and links to that saved engagement', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: CREATED }), { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Open saved assessment' }).getAttribute('href')).toBe(
      `/assessment?engagement=${CREATED}`,
    ),
  );
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/bff/v1/engagements');
  expect(init.headers).toMatchObject({ 'X-Tenant-Id': TENANT });
  expect(JSON.parse(String(init.body))).toEqual({
    title: 'October review',
    libraryVersion: '0.1.1',
    estateId: ESTATE,
    requestKey: REQUEST,
  });
});

it('creates and retries the exact request using secure randomness when randomUUID is absent', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(19);
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: CREATED }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unconfirmed'));
  vi.stubGlobal('crypto', undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await screen.findByRole('link', { name: 'Open saved assessment' });
  expect(getRandomValues).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const first = fetcher.mock.calls[0] as [string, RequestInit];
  expect(fetcher.mock.calls[1]).toEqual(first);
  const body = JSON.parse(String(first[1].body));
  expect(body.requestKey).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(first[1].headers).toMatchObject({
    'Idempotency-Key': body.requestKey,
    'X-Tenant-Id': TENANT,
  });
});

it.each(['unavailable', 'missing_methods', 'randomUUID_error', 'getRandomValues_error'])(
  'shows a never-sent editable failure when secure randomness is %s',
  async (mode) => {
    const fail = () => {
      throw new Error('private-rng-diagnostics');
    };
    vi.stubGlobal(
      'crypto',
      mode === 'unavailable'
        ? undefined
        : mode === 'missing_methods'
          ? {}
          : mode === 'randomUUID_error'
            ? { randomUUID: fail }
            : { getRandomValues: fail },
    );
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    form();
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Nothing was sent'),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    expect(
      screen.getByRole('textbox', { name: 'Assessment title' }).closest('fieldset')?.disabled,
    ).toBe(false);
    expect(document.body.textContent).not.toContain('private-rng-diagnostics');
    fireEvent.change(screen.getByRole('textbox', { name: 'Assessment title' }), {
      target: { value: 'Corrected review' },
    });
    vi.stubGlobal('crypto', { randomUUID: () => REQUEST });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ id: CREATED }), { status: 201 }));
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    await screen.findByRole('link', { name: 'Open saved assessment' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).title).toBe('Corrected review');
  },
);

it('retries an uncertain outcome with the same request key and links the replayed record', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: CREATED }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unconfirmed'));
  expect(
    screen.getByRole('textbox', { name: 'Assessment title' }).closest('fieldset')?.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Open saved assessment' }).getAttribute('href')).toBe(
      `/assessment?engagement=${CREATED}`,
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const first = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body));
  const second = JSON.parse(String((fetcher.mock.calls[1] as [string, RequestInit])[1].body));
  expect(second).toEqual(first);
});

it('shows a definitive validation refusal without trapping the form in retry mode', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Choose the current published control library.' } }),
        {
          status: 422,
        },
      ),
    ),
  );
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('current published'),
  );
  expect(screen.getByRole('textbox', { name: 'Assessment title' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(screen.queryByRole('link', { name: 'Open saved assessment' })).toBeNull();
});

it('keeps the same key when a claimed request is still in progress', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ error: { code: 'idempotency_in_progress', message: 'Pending.' } }),
      {
        status: 409,
      },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unconfirmed'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect((fetcher.mock.calls[1] as [string, RequestInit])[1].body).toBe(
    (fetcher.mock.calls[0] as [string, RequestInit])[1].body,
  );
});

it('allows a new attempt after a definitive library lookup failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'library_unavailable', message: 'Library unavailable.' },
        }),
        { status: 503 },
      ),
    ),
  );
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Library unavailable'),
  );
  expect(screen.getByRole('button', { name: 'Create assessment' })).toBeTruthy();
});

const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
function scoped(tenantId = TENANT, libraryVersion = '0.1.1') {
  return (
    <CreateAssessmentForm
      tenantId={tenantId}
      libraryVersion={libraryVersion}
      estates={[{ id: ESTATE, name: 'Primary estate' }]}
    />
  );
}

it.each(['tenant', 'library'])(
  'blocks unknown retry after %s changes and restores the exact original request',
  async (scope) => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: CREATED }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const view = form();
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    await screen.findByRole('alert');
    view.rerender(
      scoped(scope === 'tenant' ? OTHER_TENANT : TENANT, scope === 'library' ? '0.2.0' : '0.1.1'),
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Create assessment' }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('original organisation and control library');
    view.rerender(scoped());
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await screen.findByRole('link', { name: 'Open saved assessment' });
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
  },
);

it.each(['success', 'failure'])(
  'suppresses a late %s in another scope and retains its original outcome',
  async (outcome) => {
    let settle!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const view = form();
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    view.rerender(scoped(OTHER_TENANT));
    await act(async () => {
      settle(
        outcome === 'success'
          ? new Response(JSON.stringify({ id: CREATED }), { status: 201 })
          : new Response(JSON.stringify({ error: { message: 'Original tenant refusal' } }), {
              status: 422,
            }),
      );
    });
    expect(screen.queryByRole('link', { name: 'Open saved assessment' })).toBeNull();
    expect(document.body.textContent).not.toContain('Original tenant refusal');
    expect(document.body.textContent).not.toContain('Assessment created.');
    view.rerender(scoped());
    if (outcome === 'success') {
      expect(screen.getByRole('link', { name: 'Open saved assessment' })).toBeTruthy();
      fireEvent.submit(screen.getByRole('form', { name: 'Create assessment' }));
      expect(fetcher).toHaveBeenCalledOnce();
    } else expect(screen.getByRole('status').textContent).toContain('Original tenant refusal');
  },
);

it('preserves an unknown outcome when a replay receives a definitive refusal', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Permission changed' } }), { status: 403 }),
    );
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry same request' })).toBeTruthy(),
  );
  expect(
    screen.getByRole('textbox', { name: 'Assessment title' }).closest('fieldset')?.disabled,
  ).toBe(true);
});

it.each(['success', 'failure'])(
  'does not update an unmounted form after late %s',
  async (outcome) => {
    let settle!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const view = form();
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    view.unmount();
    await act(async () => {
      settle(
        outcome === 'success'
          ? new Response(JSON.stringify({ id: CREATED }), { status: 201 })
          : new Response('{}', { status: 500 }),
      );
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link')).toBeNull();
  },
);

it.each(['before switch', 'after switch'])(
  'permits a fresh empty tenant B assessment when tenant A success settles %s',
  async (timing) => {
    let settle!: (response: Response) => void;
    let nextKey = REQUEST;
    vi.stubGlobal('crypto', { randomUUID: () => nextKey });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue(new Response(JSON.stringify({ id: CREATED }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const view = form();
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    if (timing === 'after switch') view.rerender(scoped(OTHER_TENANT));
    await act(async () => {
      settle(new Response(JSON.stringify({ id: CREATED }), { status: 201 }));
    });
    if (timing === 'before switch') view.rerender(scoped(OTHER_TENANT));
    expect(screen.queryByRole('link', { name: 'Open saved assessment' })).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Assessment title' }) as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByRole('combobox', { name: 'Assessment estate (optional)' }) as HTMLSelectElement)
        .value,
    ).toBe('');
    nextKey = '66666666-6666-4666-8666-666666666666';
    fireEvent.change(screen.getByRole('textbox', { name: 'Assessment title' }), {
      target: { value: 'Tenant B review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
      'X-Tenant-Id': OTHER_TENANT,
      'Idempotency-Key': nextKey,
    });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      title: 'Tenant B review',
      libraryVersion: '0.1.1',
      requestKey: nextKey,
    });
  },
);
