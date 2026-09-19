'use client';

import { useState } from 'react';
import { Button, Input, Card, CardContent } from '@axiom/ui';

interface EmailReportActionProps {
  reportId: string;
  defaultEmail?: string;
  defaultName?: string;
  defaultPhone?: string;
  defaultCompany?: string;
  hasReadinessIndex?: boolean;
}

export function EmailReportAction({
  reportId,
  defaultEmail = '',
  defaultName = '',
  defaultPhone = '',
  defaultCompany = '',
  hasReadinessIndex = false,
}: EmailReportActionProps) {
  const [email, setEmail] = useState(defaultEmail);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await fetch('/api/gap-scan/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: reportId,
          email: email.trim(),
          name: defaultName || undefined,
          phone: defaultPhone || undefined,
          company: defaultCompany || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error?.message || `Delivery failed (HTTP ${res.status})`);
        return;
      }

      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error while sending report');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="border-teal-200 bg-gradient-to-r from-teal-50/60 to-indigo-50/40">
      <CardContent className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-500 text-white text-xs font-bold">
                ✉
              </span>
              <h3 className="font-heading text-lg font-semibold text-indigo-500">
                Email this compliance report {hasReadinessIndex ? '& Quarterly Index' : ''}
              </h3>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Receive a permanent copy of your statutory scorecard
              {hasReadinessIndex ? ', industry benchmark percentile, and roadmap' : ''} directly in
              your inbox.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:w-80">
            {sent ? (
              <div className="rounded-md border border-teal-300 bg-teal-100/70 px-4 py-2.5 text-center text-sm font-medium text-teal-800">
                ✓ Dispatched to {email}
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  placeholder="name@company.com"
                  className="bg-white"
                  disabled={sending}
                />
                <Button
                  variant="accent"
                  onClick={handleSend}
                  loading={sending}
                  disabled={!email.trim() || sending}
                >
                  Send
                </Button>
              </div>
            )}
            {error && <p className="text-xs text-ember-600">{error}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
