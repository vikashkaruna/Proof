// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ErrorPage from './error';
import GlobalError from './global-error';

afterEach(cleanup);

const privateError = Object.assign(new Error('token=private-secret; server stack'), {
  digest: 'private-digest',
});

it.each([
  ['route', ErrorPage],
  ['root layout', GlobalError],
])('%s boundary gives a safe retry and a hard sign-in route', (_name, Boundary) => {
  const reset = vi.fn();
  const view = render(<Boundary error={privateError} reset={reset} />);

  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('aria-labelledby')).toBe('recovery-title');
  expect(screen.getByRole('heading', { name: 'This page could not load' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/login');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(reset).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain('private-secret');
  expect(view.container.textContent).not.toContain('private-digest');
  expect(view.container.innerHTML).not.toContain('server stack');
});

it('root-layout failure includes its own document shell', () => {
  const view = render(<GlobalError error={privateError} reset={() => {}} />);
  expect(view.container.querySelector('html[lang="en"] body main')).toBeTruthy();
});
