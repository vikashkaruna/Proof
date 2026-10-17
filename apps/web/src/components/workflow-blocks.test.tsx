// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FactList, FieldHint, Notice, SectionCard, Step, StepList } from './workflow-blocks';

afterEach(cleanup);

it('renders a notice as a paragraph that can carry a live-region role', () => {
  render(
    <Notice tone="error" role="alert">
      Refused
    </Notice>,
  );
  const alert = screen.getByRole('alert');
  expect(alert.tagName).toBe('P');
  expect(alert.className).toContain('text-ember-700');
});

it('never uses gold, which is reserved for sealed evidence', () => {
  const { container } = render(
    <>
      {(['info', 'success', 'warning', 'error', 'neutral'] as const).map((tone) => (
        <Notice key={tone} tone={tone}>
          {tone}
        </Notice>
      ))}
      <StepList>
        <Step n={1} title="Done" state="done" />
        <Step n={2} title="Current" state="current" />
        <Step n={3} title="Todo" />
      </StepList>
    </>,
  );
  expect(container.innerHTML).not.toMatch(/gold/);
});

it('labels a section region with its heading and shows a tick for completed steps only', () => {
  render(
    <SectionCard
      aria-label="Pending requests"
      title="Pending"
      description="Saved here"
      actions={<button>Go</button>}
    >
      <StepList>
        <Step n={1} title="Check" state="done">
          <FieldHint>hint</FieldHint>
        </Step>
        <Step n={2} title="Confirm" state="current" />
      </StepList>
    </SectionCard>,
  );
  const region = screen.getByRole('region', { name: 'Pending requests' });
  expect(region.querySelector('h2')?.textContent).toBe('Pending');
  const markers = [...region.querySelectorAll('li > span[aria-hidden]')].map((m) => m.textContent);
  expect(markers).toEqual(['✓', '2']);
  expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
});

it('lists facts as term and definition pairs', () => {
  render(
    <FactList
      items={[
        { label: 'SHA-256', value: 'abc', mono: true },
        { label: 'Size', value: '1' },
      ]}
    />,
  );
  expect([...document.querySelectorAll('dt')].map((d) => d.textContent)).toEqual([
    'SHA-256',
    'Size',
  ]);
  expect(document.querySelector('dd')?.className).toContain('font-mono');
  expect(document.querySelectorAll('dd')[1]?.className).not.toContain('font-mono');
});
