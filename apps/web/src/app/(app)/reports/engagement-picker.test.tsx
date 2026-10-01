// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngagementPicker } from './engagement-picker';
import { reportRequest } from './report-request';

vi.mock('./report-request', () => ({ reportRequest: vi.fn() }));
const request = vi.mocked(reportRequest);
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const engagementA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const engagementB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const options = (
  data: { id: string; title: string; libraryVersion: string }[],
  currentLibraryVersion: string | null,
  hasMore = false,
) =>
  Response.json({
    data,
    meta: { total: data.length, limit: 20, offset: 0, hasMore },
    currentLibraryVersion,
  });
const changed = vi.fn();
const ready = vi.fn();

beforeEach(() => {
  request.mockReset();
  changed.mockReset();
  ready.mockReset();
});
afterEach(cleanup);

it('keeps a selected engagement visible across pagination and reports the exact selected id', async () => {
  request
    .mockResolvedValueOnce(
      options([{ id: engagementA, title: 'Recorded A', libraryVersion: 'v1' }], 'v1', true),
    )
    .mockResolvedValueOnce(
      options([{ id: engagementB, title: 'Recorded B', libraryVersion: 'v1' }], 'v1'),
    );
  const { container } = render(
    <EngagementPicker tenantId={tenantA} disabled={false} onChanged={changed} onReady={ready} />,
  );
  await screen.findByRole('option', { name: 'Recorded A · v1' });
  fireEvent.change(screen.getByLabelText('Engagement scope'), { target: { value: engagementA } });
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Next engagements' }));
  await screen.findByRole('option', { name: 'Recorded B · v1' });
  expect(screen.getByRole('option', { name: 'Recorded A · v1' })).toBeTruthy();
  expect((container.querySelector('select') as HTMLSelectElement).value).toBe(engagementA);
  expect(request).toHaveBeenLastCalledWith(
    tenantA,
    '/evidence-packs/options/engagements?limit=20&offset=20',
    expect.anything(),
  );
  expect(changed).toHaveBeenCalledTimes(1);
});

it('clears old tenant selection before the next tenant source resolves', async () => {
  let resolveNext!: (response: Response) => void;
  const next = new Promise<Response>((resolve) => {
    resolveNext = resolve;
  });
  request
    .mockResolvedValueOnce(
      options([{ id: engagementA, title: 'Private A', libraryVersion: 'a1' }], 'a1'),
    )
    .mockReturnValueOnce(next);
  const { rerender, container } = render(
    <EngagementPicker tenantId={tenantA} disabled={false} onChanged={changed} onReady={ready} />,
  );
  await screen.findByRole('option', { name: 'Private A · a1' });
  fireEvent.change(screen.getByLabelText('Engagement scope'), { target: { value: engagementA } });
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  rerender(
    <EngagementPicker tenantId={tenantB} disabled={false} onChanged={changed} onReady={ready} />,
  );
  expect(screen.queryByRole('option', { name: 'Private A · a1' })).toBeNull();
  expect((container.querySelector('select') as HTMLSelectElement).value).toBe('');
  expect((container.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false));
  expect(request).toHaveBeenLastCalledWith(
    tenantB,
    '/evidence-packs/options/engagements?limit=20&offset=0',
    expect.anything(),
  );
  resolveNext(options([{ id: engagementB, title: 'Private B', libraryVersion: 'b1' }], null));
  await screen.findByRole('option', { name: 'Private B · b1' });
  expect(screen.queryByRole('option', { name: 'Private A · a1' })).toBeNull();
  expect(ready).toHaveBeenLastCalledWith(false);
});

it('refuses malformed success instead of accepting an empty engagement source', async () => {
  request.mockResolvedValueOnce(
    Response.json({ data: null, meta: {}, currentLibraryVersion: 'v1' }),
  );
  render(
    <EngagementPicker tenantId={tenantA} disabled={false} onChanged={changed} onReady={ready} />,
  );
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Engagement scope').hasAttribute('disabled')).toBe(true);
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(screen.queryByText(/No engagement — current library/)).toBeNull();
});
