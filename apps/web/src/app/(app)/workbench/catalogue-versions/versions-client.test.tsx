// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogueVersionsClient } from './versions-client';
const tenant = '99161000-0000-4000-8000-000000000011',
  actor = '99161000-0000-4000-8000-000000000001';
const version = {
  libraryVersion: '0.2.0',
  rowsHash: 'a'.repeat(64),
  questionnaireDigest: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  mappingVersion: 'public-evidence-1',
  controlCount: 46,
  publishedBy: 'Reviewed publisher',
  publishedAt: '2026-10-18T00:00:00Z',
  changeLog: 'Corrected citations and commencement',
  isCurrent: false,
  approved: false,
  approvedAt: null,
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ data: { versions: [version] } }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows exact version changes and fingerprints before offering approval', async () => {
  render(<CatalogueVersionsClient tenantId={tenant} actorId={actor} />);
  await screen.findByText('Version 0.2.0');
  expect(screen.getByText('Published · awaiting founder approval')).toBeTruthy();
  expect(screen.getByText('Corrected citations and commencement')).toBeTruthy();
  expect(screen.getByText(version.manifestSha256)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve reviewed version' })).toBeNull();
});
it('does not offer approval when a candidate has not been explicitly published', async () => {
  fetchMock.mockImplementation(async () => Response.json({ data: { versions: [] } }));
  render(<CatalogueVersionsClient tenantId={tenant} actorId={actor} />);
  await screen.findByText(/Version 0.2.0 has not been published/);
  expect(screen.queryByRole('button', { name: 'Review version for approval' })).toBeNull();
});
it('binds all three MFA requests to the same reviewed intent and refreshes the recorded result', async () => {
  let approved = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/challenge'))
      return Response.json({
        data: {
          challengeId: '99161000-0000-4000-8000-000000000004',
          expiresAt: '2026-10-19T00:05:00Z',
        },
      });
    if (url.endsWith('/verify')) return Response.json({ data: { verified: true } });
    if (url.endsWith('/approve')) {
      approved = true;
      return Response.json({ data: { approved: true, libraryVersion: '0.2.0', receiptId: '161' } });
    }
    return Response.json({
      data: {
        versions: [{ ...version, approved, approvedAt: approved ? '2026-10-19T00:00:00Z' : null }],
      },
    });
  });
  render(<CatalogueVersionsClient tenantId={tenant} actorId={actor} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review version for approval' }));
  fireEvent.change(screen.getByLabelText('Approval reason'), {
    target: { value: 'Reviewed corrected source' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare approval with MFA' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed version' }));
  await screen.findByText(/Version 0.2.0 approved. Audit receipt 161/);
  await screen.findByText('Approved');
  const writes = fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body as string));
  expect(writes).toHaveLength(3);
  expect(writes[1].request).toEqual(writes[0].request);
  expect(writes[2].request).toEqual(writes[0].request);
  expect(writes[2]).not.toHaveProperty('code');
  expect(screen.queryByRole('button', { name: 'Approve reviewed version' })).toBeNull();
});
it('preserves an approval failure while refreshing rather than falsely confirming success', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/challenge')
      ? Response.json({
          data: {
            challengeId: '99161000-0000-4000-8000-000000000004',
            expiresAt: '2026-10-19T00:05:00Z',
          },
        })
      : url.endsWith('/verify')
        ? Response.json({ error: { code: 'mfa_refused' } }, { status: 403 })
        : Response.json({ data: { versions: [version] } }),
  );
  render(<CatalogueVersionsClient tenantId={tenant} actorId={actor} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review version for approval' }));
  fireEvent.change(screen.getByLabelText('Approval reason'), {
    target: { value: 'Reviewed source' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare approval with MFA' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed version' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Approval was not confirmed'),
  );
  expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/approve'))).toBe(false);
  expect(screen.queryByRole('button', { name: 'Approve reviewed version' })).toBeNull();
});

it('offers current selection only after approval and submits a distinct previous-version-bound intent', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/current/challenge')
      ? Response.json({
          data: {
            challengeId: '99161000-0000-4000-8000-000000000004',
            expiresAt: '2026-10-19T00:05:00Z',
          },
        })
      : Response.json({
          data: { versions: [{ ...version, approved: true, approvedAt: '2026-10-19T00:00:00Z' }] },
        }),
  );
  render(<CatalogueVersionsClient tenantId={tenant} actorId={actor} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Make current for new assessments' }));
  expect(screen.getByText(/Existing assessments keep their recorded version/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Approval reason'), {
    target: { value: 'Adopt corrected version for new assessments' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare approval with MFA' }));
  await screen.findByRole('button', { name: 'Make reviewed version current' });
  const sent = fetchMock.mock.calls.find(([url]) => (url as string).endsWith('/current/challenge'));
  expect(JSON.parse(sent![1].body)).toMatchObject({
    request: { transition: 'make_current', previousCurrentVersion: null, libraryVersion: '0.2.0' },
  });
  expect(screen.queryByRole('button', { name: 'Approve reviewed version' })).toBeNull();
});
