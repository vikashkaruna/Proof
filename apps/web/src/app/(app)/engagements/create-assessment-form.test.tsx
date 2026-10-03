// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  render(
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
