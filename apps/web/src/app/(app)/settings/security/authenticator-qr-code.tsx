'use client';

import QRCode from 'qrcode';

/** Encode locally: an enrolment secret must never be sent to a QR web service. */
function encodeSetup(provisioningUri: string): { size: number; path: string } | null {
  try {
    const uri = new URL(provisioningUri);
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || provisioningUri.length > 2048)
      throw new Error('Invalid authenticator setup');
    const qr = QRCode.create(provisioningUri, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const cells: string[] = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (qr.modules.get(y, x)) cells.push(`M${x + 4},${y + 4}h1v1h-1z`);
    return { size, path: cells.join('') };
  } catch {
    return null;
  }
}

export function AuthenticatorQrCode({ provisioningUri }: { provisioningUri: string }) {
  const qr = encodeSetup(provisioningUri);
  if (qr) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-700">
          In your authenticator app, choose Add account → Scan QR code.
        </p>
        <svg
          role="img"
          aria-label="Authenticator setup QR code"
          viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
          width="240"
          height="240"
          className="max-w-full"
          shapeRendering="crispEdges"
        >
          <title>Scan with your authenticator app</title>
          <rect width="100%" height="100%" fill="white" />
          <path d={qr.path} fill="black" />
        </svg>
        <p className="text-xs text-slate-600">
          Keep this QR code and setup key private. Use the manual setup key below if scanning is
          unavailable.
        </p>
      </div>
    );
  }
  return (
    <p role="alert" className="text-sm text-slate-700">
      The QR code could not be displayed. Add the manual setup key below as a time-based account.
    </p>
  );
}
