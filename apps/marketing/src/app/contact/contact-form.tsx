'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BRAND } from '@axiom/config';
import { Button, Input, Label, Textarea } from '@axiom/ui';
import { CheckCircle2, AlertCircle, Loader2, Send } from 'lucide-react';

type ContactDelivery = 'not_configured' | 'pending' | 'sent' | 'failed';

// Each message states only what the server recorded; storage is always durable here.
const deliveryCopy: Record<ContactDelivery, string> = {
  sent: `Your message has been saved and emailed to ${BRAND.company}'s founder.`,
  not_configured: `Your message has been saved for ${BRAND.company}'s founder to review.`,
  pending: `Your message has been saved for ${BRAND.company}'s founder to review.`,
  failed: `Your message has been saved for ${BRAND.company}'s founder to review; the email notification could not be sent.`,
};

function parseDelivery(value: unknown): ContactDelivery {
  return value === 'sent' || value === 'pending' || value === 'failed' ? value : 'not_configured';
}

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [delivery, setDelivery] = useState<ContactDelivery>('not_configured');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company: company.trim() || undefined,
          message: message.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.error?.details?.fieldErrors) {
          setFieldErrors(data.error.details.fieldErrors);
        }
        setError(data?.error?.message || `Error ${res.status}: Failed to send message`);
        return;
      }

      setDelivery(parseDelivery(data?.delivery));
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setName('');
    setEmail('');
    setCompany('');
    setMessage('');
    setError(null);
    setFieldErrors({});
    setSubmitted(false);
    setDelivery('not_configured');
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 text-teal-600">
          <CheckCircle2 className="h-8 w-8" />
        </div>
        <h2 className="mt-4 font-heading text-xl font-semibold text-slate-900">
          {delivery === 'sent' ? 'Message sent successfully' : 'Message received'}
        </h2>
        <p className="mt-2 max-w-md text-sm text-slate-600" data-testid="contact-delivery-outcome">
          Thank you, <span className="font-medium text-slate-800">{name}</span>.{' '}
          {deliveryCopy[delivery]} We will get back to you at{' '}
          <span className="font-medium text-slate-800">{email}</span> within 24 hours.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button variant="outline" size="sm" onClick={handleReset}>
            Send another message
          </Button>
          <Button asChild={false} variant="primary" size="sm">
            <Link href="/#gap-scan">Run 5-min gap-scan</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-ember-200 bg-ember-50 p-3 text-sm text-ember-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-ember-600" />
          <div>
            <p className="font-medium">{error}</p>
            {Object.keys(fieldErrors).length > 0 && (
              <ul className="mt-1 list-inside list-disc text-xs text-ember-700">
                {Object.entries(fieldErrors).map(([field, errs]) => (
                  <li key={field}>
                    <strong className="capitalize">{field}</strong>: {errs.join(', ')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contact-name" required>
          Your name
        </Label>
        <Input
          id="contact-name"
          name="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ravi Sharma"
          disabled={submitting}
        />
        {fieldErrors.name && <p className="text-xs text-ember-600">{fieldErrors.name[0]}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contact-email" required>
          Email address
        </Label>
        <Input
          id="contact-email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={submitting}
        />
        {fieldErrors.email && <p className="text-xs text-ember-600">{fieldErrors.email[0]}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contact-company">Company</Label>
        <Input
          id="contact-company"
          name="company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Acme Fintech Pvt Ltd"
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contact-message" required>
          How can we help?
        </Label>
        <Textarea
          id="contact-message"
          name="message"
          required
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="We have ~400 employees, process children data, and need a readiness assessment before May 2027."
          disabled={submitting}
        />
        {fieldErrors.message && <p className="text-xs text-ember-600">{fieldErrors.message[0]}</p>}
      </div>

      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={submitting}
          className="w-full sm:w-auto flex items-center gap-2"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Sending...</span>
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              <span>Send message</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
