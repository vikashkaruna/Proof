/** Reload server state after the BFF records a session-bound MFA attestation. */
export function navigateAfterVerifiedMfa(path: string): void {
  window.location.replace(path);
}
