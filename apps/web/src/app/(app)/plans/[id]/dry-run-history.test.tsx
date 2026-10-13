import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DryRunHistory, type DryRunRow } from './dry-run-history';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['2026-10-13T15:00:00.000Z', 'in 3h'],
  ['2026-10-13T09:00:00.000Z', '3h ago'],
])('shows the actual approval-window direction for %s', (expiresAt, expected) => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T12:00:00.000Z'));
  const run: DryRunRow = {
    id: 'run-1',
    action_id: 'action-1',
    status: 'succeeded',
    diff: {},
    refusal_reason: null,
    renderable: true,
    parameters_hash: 'a'.repeat(64),
    rollback_definition_hash: 'b'.repeat(64),
    simulated_by: 'sudhaar',
    correlation_id: 'correlation-1',
    expires_at: expiresAt,
    created_at: '2026-10-13T08:00:00.000Z',
  };
  const html = renderToStaticMarkup(
    <DryRunHistory runs={[run]} actionLabels={new Map([['action-1', 'Review retention']])} />,
  );
  expect(html).toContain('window ends');
  expect(html).toContain(`(${expected})`);
  expect(html).not.toMatch(/-\d+[smhd] ago/);
  expect(html).toContain('Review retention');
});
