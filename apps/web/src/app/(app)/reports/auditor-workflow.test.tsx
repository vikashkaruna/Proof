// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoardWorkflow } from './board-workflow';
import { AuditorWorkflow } from './auditor-workflow';
import { reportRequest } from './report-request';
vi.mock('./report-request', async (original) => ({
  ...(await original<typeof import('./report-request')>()),
  reportRequest: vi.fn(),
}));
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const engagementId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const transport = vi.mocked(reportRequest);
beforeEach(() => {
  localStorage.clear();
  transport.mockReset();
  transport.mockImplementation((_tenant, path, options) => {
    if (options?.body) return Promise.reject(new Error('The outcome is uncertain.'));
    if (path.includes('assessment-options'))
      return Promise.resolve(
        Response.json({
          assessments: [
            {
              assessmentRunId: runId,
              engagementId,
              engagementTitle: 'Saved assessment',
              finalizedAt: '2026-10-15T00:00:00Z',
              libraryVersion: '0.1.1',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      );
    return Promise.resolve(Response.json({ requests: [], total: 0, limit: 20, offset: 0 }));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const scenarios = [
  ['board', BoardWorkflow, 'Request board report', 'Request board draft'],
  ['auditor', AuditorWorkflow, 'Request auditor review pack', 'Request review pack'],
] as const;
function open(Component: typeof BoardWorkflow | typeof AuditorWorkflow) {
  return render(
    <Component
      tenantId={tenantId}
      actorId={actorId}
      canRequest
      canManage
      onOpenReport={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}
async function submit(formName: string, button: string) {
  const form = within(screen.getByRole('form', { name: formName }));
  await screen.findByRole('option', { name: /Saved assessment/ });
  fireEvent.change(form.getByRole('combobox'), { target: { value: runId } });
  fireEvent.change(form.getByRole('textbox'), { target: { value: 'Original request' } });
  fireEvent.click(form.getByRole('checkbox'));
  fireEvent.click(form.getByRole('button', { name: button }));
  await screen.findByText('The outcome is uncertain.');
  return form;
}
it.each(scenarios)(
  '%s freezes the exact body after a lost response rather than reusing its key for edited content',
  async (_kind, Component, formName, button) => {
    open(Component);
    const form = await submit(formName, button);
    expect((form.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect((form.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'Retained report request' }).textContent).toContain(
      'Original request',
    );
  },
);
it.each(scenarios)(
  '%s recovers its exact unresolved request after reload without an automatic POST',
  async (_kind, Component, formName, button) => {
    const first = open(Component);
    await submit(formName, button);
    const postsBefore = transport.mock.calls.filter((c) => c[2]?.body).length;
    first.unmount();
    open(Component);
    expect(
      (await screen.findByRole('region', { name: 'Retained report request' })).textContent,
    ).toContain('Original request');
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(postsBefore);
  },
);
const receipt = () => ({
  requestId: '77777777-7777-4777-8777-777777777777',
  reportId: null,
  status: 'requested',
  replayed: true,
});
function retryExact() {
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'I authorize checking or retrying this exact retained request.',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check or retry exact retained request' }));
}
it.each(scenarios)(
  '%s positively reconciles only the retained body/key after reload with explicit confirmation',
  async (_kind, Component, formName, button) => {
    const first = open(Component);
    await submit(formName, button);
    const original = transport.mock.calls.find((c) => c[2]?.body)!;
    first.unmount();
    open(Component);
    await screen.findByRole('region', { name: 'Retained report request' });
    const reads = transport.getMockImplementation()!;
    transport.mockImplementation((tenant, path, options) =>
      options?.body ? Promise.resolve(Response.json(receipt())) : reads(tenant, path, options),
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Check or retry exact retained request',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    retryExact();
    await screen.findByText(/Report request 77777777.* is recorded/);
    const posts = transport.mock.calls.filter((c) => c[2]?.body);
    expect(posts).toHaveLength(2);
    expect(posts[1]![0]).toBe(tenantId);
    expect(posts[1]![2]).toEqual(original[2]);
    expect(posts[1]![2]?.expectedActorId).toBe(actorId);
    expect(localStorage.length).toBe(0);
    expect(screen.queryByRole('region', { name: 'Retained report request' })).toBeNull();
    expect(screen.queryByText(/report was generated or released\.$/)).not.toBeNull();
  },
);
it.each(scenarios)(
  '%s preserves the unknown request after later not-found, server failure, or malformed positive reply',
  async (_kind, Component, formName, button) => {
    open(Component);
    await submit(formName, button);
    const saved = localStorage.getItem(localStorage.key(0)!);
    const reads = transport.getMockImplementation()!;
    for (const outcome of ['not_found', 'unavailable', 'malformed']) {
      transport.mockImplementation((tenant, path, options) =>
        !options?.body
          ? reads(tenant, path, options)
          : outcome === 'malformed'
            ? Promise.resolve(Response.json({ requestId: 'invalid', status: 'requested' }))
            : Promise.reject(new Error(outcome)),
      );
      retryExact();
      await waitFor(() =>
        expect(
          (
            screen.getByRole('button', {
              name: 'Check or retry exact retained request',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true),
      );
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).not.toContain('The outcome is uncertain.'),
      );
      expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
      expect(screen.getByRole('region', { name: 'Retained report request' }).textContent).toContain(
        'Original request',
      );
    }
  },
);
it.each(scenarios)(
  '%s keeps a known receipt when cleanup or refresh fails without another POST',
  async (_kind, Component, formName, button) => {
    render(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={() => {
          throw Error('refresh failed');
        }}
      />,
    );
    await submit(formName, button);
    const reads = transport.getMockImplementation()!;
    transport.mockImplementation((tenant, path, options) =>
      options?.body ? Promise.resolve(Response.json(receipt())) : reads(tenant, path, options),
    );
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    retryExact();
    await screen.findByRole('button', { name: 'Clear confirmed browser reference' });
    expect(screen.getByText(/Report request 77777777.* is recorded/).textContent).toContain(
      'is recorded',
    );
    expect(
      screen.queryByRole('button', { name: 'Check or retry exact retained request' }),
    ).toBeNull();
    const postCount = transport.mock.calls.filter((c) => c[2]?.body).length;
    remove.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Clear confirmed browser reference' }));
    await waitFor(() => expect(localStorage.length).toBe(0));
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(postCount);
  },
);
it.each(scenarios)(
  '%s hides another tenant/account intent and restores it only in the original context',
  async (_kind, Component, formName, button) => {
    const view = open(Component);
    await submit(formName, button);
    const saved = localStorage.getItem(localStorage.key(0)!);
    view.rerender(
      <Component
        tenantId={runId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Retained report request' })).toBeNull(),
    );
    view.rerender(
      <Component
        tenantId={tenantId}
        actorId={runId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Retained report request' })).toBeNull(),
    );
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
    view.rerender(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(
      (await screen.findByRole('region', { name: 'Retained report request' })).textContent,
    ).toContain('Original request');
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
  },
);
it.each(scenarios)(
  '%s retains an unresolved intent after role loss and refuses retry',
  async (_kind, Component, formName, button) => {
    const view = open(Component);
    await submit(formName, button);
    view.rerender(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest={false}
        canManage={false}
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    // Workflow is permission-hidden; its durable original intent is still retained.
    expect(localStorage.length).toBe(1);
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
    view.rerender(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByRole('region', { name: 'Retained report request' });
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
  },
);
it.each(scenarios)(
  '%s refuses unavailable storage before any mutation and leaves inputs editable after RNG preparation failure',
  async (_kind, Component, formName, button) => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('Storage unavailable');
    });
    open(Component);
    const form = within(screen.getByRole('form', { name: formName }));
    await screen.findByRole('option', { name: /Saved assessment/ });
    fireEvent.change(form.getByRole('combobox'), { target: { value: runId } });
    fireEvent.change(form.getByRole('textbox'), { target: { value: 'Original request' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: button }));
    await screen.findByText('Storage unavailable');
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    write.mockRestore();
  },
);
it.each(scenarios)(
  '%s suppresses a late positive reply after tenant switch or unmount and preserves its original journal',
  async (_kind, Component, formName, button) => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const reads = transport.getMockImplementation()!;
    transport.mockImplementation((tenant, path, options) =>
      options?.body ? pending : reads(tenant, path, options),
    );
    const changed = vi.fn();
    const view = render(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={changed}
      />,
    );
    const form = within(screen.getByRole('form', { name: formName }));
    await screen.findByRole('option', { name: /Saved assessment/ });
    fireEvent.change(form.getByRole('combobox'), { target: { value: runId } });
    fireEvent.change(form.getByRole('textbox'), { target: { value: 'Original request' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: button }));
    await waitFor(() => expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1));
    const raw = localStorage.getItem(localStorage.key(0)!);
    view.rerender(
      <Component
        tenantId={runId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={changed}
      />,
    );
    resolve(Response.json(receipt()));
    await waitFor(() => expect(screen.queryByText(/is recorded\. No report/)).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).not.toHaveBeenCalled();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(raw);
    expect(screen.queryByRole('region', { name: 'Retained report request' })).toBeNull();
    view.unmount();
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
  },
);
it.each(scenarios)(
  '%s refuses a changed retained entry before retry transport',
  async (_kind, Component, formName, button) => {
    open(Component);
    await submit(formName, button);
    const name = localStorage.key(0)!,
      stored = JSON.parse(localStorage.getItem(name)!);
    stored.body.title = 'Changed by another tab';
    // A sibling tab cannot silently change the immutable operation visible here.
    localStorage.setItem(name, JSON.stringify(stored));
    retryExact();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/changed|scope|content/),
    );
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
    expect(localStorage.length).toBe(1);
  },
);
it.each(scenarios)(
  '%s fails visibly before retention or transport without secure browser randomness',
  async (_kind, Component, formName, button) => {
    vi.stubGlobal('crypto', {});
    open(Component);
    const form = within(screen.getByRole('form', { name: formName }));
    await screen.findByRole('option', { name: /Saved assessment/ });
    fireEvent.change(form.getByRole('combobox'), { target: { value: runId } });
    fireEvent.change(form.getByRole('textbox'), { target: { value: 'Original request' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: button }));
    await screen.findByText(/Request not sent\. Secure browser randomness/);
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect((form.getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
  },
);
it.each(scenarios)(
  '%s refuses a canonical same-key storage replacement without adopting its changed intent',
  async (_kind, Component, formName, button) => {
    const { canonicalJson } = await import('@axiom/ledger');
    open(Component);
    await submit(formName, button);
    const name = localStorage.key(0)!,
      stored = JSON.parse(localStorage.getItem(name)!);
    stored.body.title = 'Canonical changed content';
    localStorage.setItem(name, canonicalJson(stored));
    window.dispatchEvent(new StorageEvent('storage', { key: name }));
    await screen.findByText(/Report request storage or current account identity is unavailable/);
    expect(
      (
        screen.getByRole('button', {
          name: 'Check or retry exact retained request',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole('region', { name: 'Retained report request' }).textContent).toContain(
      'Original request',
    );
    expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1);
  },
);
it.each(scenarios)(
  '%s never clears storage or calls parent refresh after unmount with a late positive reply',
  async (_kind, Component, formName, button) => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const reads = transport.getMockImplementation()!;
    transport.mockImplementation((tenant, path, options) =>
      options?.body ? pending : reads(tenant, path, options),
    );
    const changed = vi.fn();
    const view = render(
      <Component
        tenantId={tenantId}
        actorId={actorId}
        canRequest
        canManage
        onOpenReport={vi.fn()}
        onChanged={changed}
      />,
    );
    const form = within(screen.getByRole('form', { name: formName }));
    await screen.findByRole('option', { name: /Saved assessment/ });
    fireEvent.change(form.getByRole('combobox'), { target: { value: runId } });
    fireEvent.change(form.getByRole('textbox'), { target: { value: 'Original request' } });
    fireEvent.click(form.getByRole('checkbox'));
    fireEvent.click(form.getByRole('button', { name: button }));
    await waitFor(() => expect(transport.mock.calls.filter((c) => c[2]?.body)).toHaveLength(1));
    const saved = localStorage.getItem(localStorage.key(0)!);
    view.unmount();
    resolve(Response.json(receipt()));
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).not.toHaveBeenCalled();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
  },
);
