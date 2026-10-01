// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactForm } from './contact-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillInquiry() {
  fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: ' Ravi Sharma ' } });
  fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: ' ravi@example.invalid ' } });
  fireEvent.change(screen.getByLabelText(/Company/), { target: { value: ' Acme ' } });
  fireEvent.change(screen.getByLabelText(/How can we help/), { target: { value: ' Need a review. ' } });
}

it('submits trimmed inquiry data and reports only the server-recorded delivery outcome', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ delivery: 'not_configured' }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ContactForm />);
  fillInquiry();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(screen.getByTestId('contact-delivery-outcome')).toHaveProperty('textContent', expect.stringContaining('saved')));
  expect(screen.getByText('Message received')).toBeTruthy();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/contact');
  expect(JSON.parse(init.body)).toEqual({ name: 'Ravi Sharma', email: 'ravi@example.invalid', company: 'Acme', message: 'Need a review.' });
  fireEvent.click(screen.getByRole('button', { name: 'Send another message' }));
  expect(screen.getByLabelText(/Your name/)).toHaveProperty('value', '');
});

it('shows field errors and does not claim delivery on BFF refusal', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Invalid inquiry', details: { fieldErrors: { email: ['Invalid email'] } } } }, { status: 400 })));
  render(<ContactForm />);
  fillInquiry();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid inquiry'));
  expect(screen.getByRole('alert').textContent).toContain('Invalid email');
  expect(screen.queryByText('Message received')).toBeNull();
});

it('keeps the form available after a network failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network offline')));
  render(<ContactForm />);
  fillInquiry();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Network offline'));
  expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false);
});
