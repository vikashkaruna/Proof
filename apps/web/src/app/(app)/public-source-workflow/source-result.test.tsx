// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { publicSourcePreviewSchema, publicAgentObservationSchema } from '@axiom/types';
import { SourceProjectionView, SourceResultView } from './source-result';
const id = '11111111-1111-4111-8111-111111111111';
const binding = {
  tenant_id: id,
  engagement_id: id,
  check_id: id,
  root_content_sha256: 'a'.repeat(64),
  projection_sha256: 'b'.repeat(64),
  projection_version: 1,
};
const private_facts = {
  hosting_region: 'unknown',
  backend_personal_data: 'unknown',
  cross_border_processing: 'unknown',
};
afterEach(cleanup);
it('distinguishes observed zero, legacy unexamined and unavailable saved pages', () => {
  const preview = publicSourcePreviewSchema.parse({
    runtime_binding: binding,
    projection: {
      version: 1,
      pages: [
        {
          page: 'root',
          status: 'checked',
          content_sha256: 'a'.repeat(64),
          form_metadata: {
            version: 1,
            scope: 'static_html_form_descendants',
            sourceSha256: 'a'.repeat(64),
            observedFormCount: 0,
            formsTruncated: false,
            forms: [],
          },
        },
        { page: 'privacy', status: 'checked', content_sha256: 'c'.repeat(64) },
        { page: 'contact', status: 'unavailable' },
      ],
    },
  });
  render(<SourceProjectionView preview={preview} />);
  expect(screen.getByText('0 forms observed in retrieved static HTML.')).toBeTruthy();
  expect(screen.getByText('Static HTML forms were not examined in this saved check.')).toBeTruthy();
  expect(
    screen.getByText('Form inspection unavailable: this page could not be retrieved.'),
  ).toBeTruthy();
});
it('renders retained static attributes with truncation and excluded-control limits', () => {
  const forms = [1, 2, 3].map((ordinal) => ({
    ordinal,
    method: 'post',
    observedControlCount: 14,
    excludedControlCount: 1,
    controlsTruncated: true,
    controls: Array.from({ length: 12 }, (_, index) => ({
      ordinal: index + 2,
      element: 'input',
      inputType: 'email',
      requiredAttribute: true,
      disabledAttribute: false,
    })),
  }));
  const preview = publicSourcePreviewSchema.parse({
    runtime_binding: binding,
    creation_receipt: '9',
    binding_id: id,
    projection: {
      version: 1,
      pages: [
        {
          page: 'root',
          status: 'checked',
          content_sha256: 'a'.repeat(64),
          form_metadata: {
            version: 1,
            scope: 'static_html_form_descendants',
            sourceSha256: 'a'.repeat(64),
            observedFormCount: 4,
            formsTruncated: true,
            forms,
          },
        },
      ],
    },
  });
  render(<SourceProjectionView preview={preview} />);
  expect(
    screen.getByText('Form details are truncated: 3 of 4 observed forms are recorded.'),
  ).toBeTruthy();
  expect(
    screen.getAllByText(
      'Control details are truncated; additional eligible controls were observed.',
    ),
  ).toHaveLength(3);
  expect(
    screen.getAllByText(/14 controls observed · 1 excluded · 12 control details recorded/),
  ).toHaveLength(3);
  expect(screen.getByText('Binding receipt: 9')).toBeTruthy();
});
it('labels email and telephone indicators as tentative and keeps unknowns and proof inspectable', () => {
  const result = publicAgentObservationSchema.parse({
    observation_id: id,
    dispatch_id: id,
    binding_id: id,
    run_id: id,
    output_sha256: 'c'.repeat(64),
    completion_receipt: '19',
    agent: 'vibhaag',
    output: {
      mode: 'public_website',
      source_binding: binding,
      indicators: ['email', 'tel'].map((input_type, index) => ({
        page: 'root',
        content_sha256: 'a'.repeat(64),
        form_ordinal: 1,
        control_ordinal: index + 1,
        input_type,
        indicator: 'potential_contact_collection',
        requires_human_review: true,
      })),
      private_facts,
      unexamined_pages: ['privacy'],
      unavailable_pages: ['contact'],
      scope_limited: true,
    },
  });
  render(<SourceResultView observation={result} />);
  expect(screen.getAllByText(/Potential contact collection/)).toHaveLength(2);
  expect(screen.getByText(/email input · requires human review/)).toBeTruthy();
  expect(screen.getByText(/tel input · requires human review/)).toBeTruthy();
  expect(screen.getByText('Human review pending')).toBeTruthy();
  expect(screen.getByText(/Private hosting: unknown/)).toBeTruthy();
  expect(screen.getByText('Unexamined pages: privacy.')).toBeTruthy();
  expect(screen.getByText('Unavailable pages: contact.')).toBeTruthy();
  expect(screen.getByText('Review retained receipts and hashes')).toBeTruthy();
  expect(screen.getByText('19')).toBeTruthy();
});
