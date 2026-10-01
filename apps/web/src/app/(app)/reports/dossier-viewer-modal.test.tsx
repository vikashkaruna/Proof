// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PramaanDossier } from '@axiom/types';
import { DossierViewerModal } from './dossier-viewer-modal';

afterEach(cleanup);
const hex = 'a'.repeat(64);
const dossier = (over: Partial<PramaanDossier> = {}): PramaanDossier => ({
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  engagementId: '33333333-3333-4333-8333-333333333333',
  reportId: '44444444-4444-4444-8444-444444444444',
  dossierType: 'board_executive',
  title: 'Board dossier',
  status: 'draft',
  merkleRoot: hex,
  manifestHash: hex,
  proofSealHash: hex,
  metadata: {},
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
  sourceBound: true,
  archiveStatus: 'settled',
  archiveHash: 'b'.repeat(64),
  archiveVersionId: 'ver-1',
  operationKey: '55555555-5555-4555-8555-555555555555',
  ...over,
});
const handlers = () => ({
  onClose: vi.fn(),
  onSeal: vi.fn(),
  onDownload: vi.fn(),
  onReconcile: vi.fn(),
  onRetryMissing: vi.fn(),
});
const view = (
  d: PramaanDossier | null,
  over: { isOpen?: boolean; canRelease?: boolean; busy?: boolean } = {},
) => {
  const h = handlers();
  render(
    <DossierViewerModal
      dossier={d}
      isOpen={over.isOpen ?? true}
      canRelease={over.canRelease ?? true}
      busy={over.busy ?? false}
      {...h}
    />,
  );
  return h;
};

it('renders nothing when closed or when no dossier is selected', () => {
  view(dossier(), { isOpen: false });
  expect(screen.queryByRole('dialog')).toBeNull();
  cleanup();
  view(null);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('states that a historical record is not a verified source and offers no seal or download', () => {
  view(dossier({ sourceBound: false, archiveStatus: null, archiveHash: null, engagementId: null }));
  expect(screen.getByText('Historical dossier record')).toBeTruthy();
  expect(screen.getByText(/does not establish a verified source/)).toBeTruthy();
  expect(screen.getByText('Tenant-level breach record')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Seal as founder' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download verified archive' })).toBeNull();
  expect(screen.queryByText('Archive SHA-256')).toBeNull();
});

it('keeps pending archives unsealable and routes recovery actions with the exact dossier', () => {
  const d = dossier({ archiveStatus: 'pending' });
  const h = view(d);
  expect(screen.getByText(/archive outcome is pending/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Seal as founder' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download verified archive' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check exact provider version' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry only if missing' }));
  expect(h.onReconcile).toHaveBeenCalledWith(d);
  expect(h.onRetryMissing).toHaveBeenCalledWith(d);
});

it('hides retry from non-releasers and hides recovery entirely without an operation key', () => {
  view(dossier({ archiveStatus: 'pending' }), { canRelease: false });
  expect(screen.getByRole('button', { name: 'Check exact provider version' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry only if missing' })).toBeNull();
  cleanup();
  view(dossier({ archiveStatus: 'pending', operationKey: null }));
  expect(screen.queryByRole('button', { name: 'Check exact provider version' })).toBeNull();
});

it('offers seal and download only to a releaser on a settled draft and disables them while busy', () => {
  const d = dossier();
  const h = view(d);
  fireEvent.click(screen.getByRole('button', { name: 'Seal as founder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Download verified archive' }));
  expect(h.onSeal).toHaveBeenCalledWith(d);
  expect(h.onDownload).toHaveBeenCalledWith(d);
  cleanup();
  view(d, { canRelease: false });
  expect(screen.queryByRole('button', { name: 'Seal as founder' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download verified archive' })).toBeNull();
  cleanup();
  view(dossier({ status: 'sealed' }));
  expect(screen.queryByRole('button', { name: 'Seal as founder' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Download verified archive' })).toBeTruthy();
  cleanup();
  view(d, { busy: true });
  expect(
    (screen.getByRole('button', { name: 'Seal as founder' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it.each([
  ['auditor_assurance', /not an independent audit/],
  ['dpb_statutory', /does not verify regulator receipt/],
  ['technical_register', /does not independently certify execution/],
] as const)('keeps the %s limitation visible beside a settled archive', (type, limitation) => {
  view(dossier({ dossierType: type }));
  expect(screen.getByText(limitation)).toBeTruthy();
});

it('closes on Escape, restores focus and traps Tab inside the dialog', () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const h = view(dossier());
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Close dossier details' }),
  );
  const buttons = Array.from(
    screen.getByRole('dialog').querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  );
  const last = buttons[buttons.length - 1]!;
  last.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(buttons[0]);
  buttons[0]!.focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(h.onClose).toHaveBeenCalledTimes(1);
  cleanup();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
