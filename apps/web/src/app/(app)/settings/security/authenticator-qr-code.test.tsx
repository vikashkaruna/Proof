// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthenticatorQrCode } from './authenticator-qr-code';

afterEach(cleanup);
it('renders setup locally with a quiet margin and no remote image or request', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const { container } = render(
    <AuthenticatorQrCode provisioningUri="otpauth://totp/Axiom:synthetic%40example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=Axiom" />,
  );
  const qr = screen.getByRole('img', { name: 'Authenticator setup QR code' });
  expect(qr.tagName.toLowerCase()).toBe('svg');
  expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+,\d+h1v1h-1z/);
  expect(qr.querySelector('rect')?.getAttribute('fill')).toBe('white');
  expect(container.querySelector('img, image, a')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
});
it.each(['https://example.invalid/qr?secret=private', 'otpauth://hotp/account', 'invalid'])(
  'shows manual setup guidance for an unsupported provisioning URI: %s',
  (provisioningUri) => {
    render(<AuthenticatorQrCode provisioningUri={provisioningUri} />);
    expect(screen.getByRole('alert').textContent).toContain('manual setup key');
    expect(screen.queryByRole('img')).toBeNull();
  },
);
