// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { publicFormMetadataSchema } from '@axiom/types';
import { PublicFormFacts } from './public-form-facts';
afterEach(cleanup);
const metadata = publicFormMetadataSchema.parse({
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: 'a'.repeat(64),
  observedFormCount: 1,
  formsTruncated: false,
  forms: [
    {
      ordinal: 1,
      method: 'get',
      observedControlCount: 8,
      excludedControlCount: 1,
      controlsTruncated: false,
      controls: ['text', 'text', 'text', 'email', 'tel', 'textarea', 'select'].map(
        (kind, index) => ({
          ordinal: index + 1,
          element: kind === 'textarea' || kind === 'select' ? kind : 'input',
          ...(kind === 'textarea' || kind === 'select' ? {} : { inputType: kind }),
          requiredAttribute: index === 3,
          disabledAttribute: false,
        }),
      ),
    },
  ],
});
it('shows saved control types and counts without inventing excluded details or actual submissions', () => {
  const original = JSON.stringify(metadata);
  render(<PublicFormFacts pageLabel="Contact" metadata={metadata} />);
  expect(screen.getByText('Page retrieved · Static forms inspected')).toBeTruthy();
  expect(
    screen.getByText(/8 controls observed · 1 excluded · 7 control details recorded/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Recorded control types: text input: 3 · email input: 1 · tel input: 1 · textarea: 1 · select: 1',
    ),
  ).toBeTruthy();
  expect(screen.getByText(/HTML recorded method \(declared or default\): GET/)).toBeTruthy();
  expect(screen.getByText(/GET is the HTML default/)).toBeTruthy();
  expect(screen.getByText(/The exact exclusion reasons were not retained/)).toBeTruthy();
  expect(screen.getByText(/JavaScript submission behaviour is unverified/)).toBeTruthy();
  const details = screen.getByText('Inspect recorded form attributes').closest('details');
  expect(details?.hasAttribute('open')).toBe(false);
  expect(details?.textContent).toContain('Required attribute: present');
  expect(JSON.stringify(metadata)).toBe(original);
});
it('distinguishes an inspected zero-form page from unavailable and legacy unexamined pages', () => {
  const { rerender } = render(
    <PublicFormFacts
      pageLabel="Root"
      metadata={{ ...metadata, observedFormCount: 0, forms: [] }}
    />,
  );
  expect(screen.getByText('Page retrieved · Static forms inspected')).toBeTruthy();
  expect(
    screen.getByText('No static HTML form elements were observed on this inspected page.'),
  ).toBeTruthy();
  rerender(<PublicFormFacts pageLabel="Root" />);
  expect(screen.getByText('Page retrieved · Static forms unexamined')).toBeTruthy();
  expect(screen.queryByText(/No static HTML form elements/)).toBeNull();
  rerender(<PublicFormFacts pageLabel="Root" unavailable />);
  expect(screen.getByText('Page unavailable · Static forms not inspected')).toBeTruthy();
  expect(screen.queryByText(/Page retrieved/)).toBeNull();
});
