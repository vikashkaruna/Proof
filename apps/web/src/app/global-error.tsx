'use client';

import './globals.css';
import { ErrorRecovery } from './error-recovery';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#F4F6F8] font-sans antialiased">
        <ErrorRecovery reset={reset} />
      </body>
    </html>
  );
}
