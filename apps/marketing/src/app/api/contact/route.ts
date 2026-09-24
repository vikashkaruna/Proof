import { NextResponse } from 'next/server';
import { ContactSubmitSchema } from '@axiom/types';
import { gapScanBackend } from '../../../lib/gap-scan-backend';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () =>
  NextResponse.json(
    {
      error: {
        code: 'service_unavailable',
        message: 'Your message could not be saved. Please try again.',
      },
    },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
  );

/**
 * C-W0-6: SSR validates and forwards to the BFF, which persists the inquiry and
 * owns any mail attempt. No inquiry is stored in, or mailed from, this process.
 */
export async function POST(request: Request) {
  const parsed = ContactSubmitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_failed',
          message: 'Please verify all fields before submitting',
          details: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }
  try {
    const res = await gapScanBackend('/public/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    const payload: unknown = await res.json();
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' };
    const retryAfter = res.headers.get('Retry-After');
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return NextResponse.json(payload, { status: res.status, headers });
  } catch {
    return unavailable();
  }
}

/** Delivery configuration only; used by the acceptance preflight. */
export async function GET() {
  try {
    const res = await gapScanBackend('/public/contact/config');
    const body = (await res.json()) as { emailDeliveryEnabled?: unknown };
    if (!res.ok || typeof body.emailDeliveryEnabled !== 'boolean') return unavailable();
    return NextResponse.json(
      { status: 'healthy', emailConfigured: body.emailDeliveryEnabled },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch {
    return unavailable();
  }
}
