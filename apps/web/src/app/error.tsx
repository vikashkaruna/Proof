'use client';

import { ErrorRecovery } from './error-recovery';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorRecovery reset={reset} />;
}
