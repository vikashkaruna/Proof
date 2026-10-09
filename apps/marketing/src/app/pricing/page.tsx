import Link from 'next/link';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
} from '@axiom/ui';

export const metadata = { title: 'Pricing' };

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <Badge variant="indigo">Founder & Partner(s) led program</Badge>
      <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-indigo-500 sm:text-4xl">
        Pricing
      </h1>
      <p className="mt-3 max-w-2xl text-lg text-slate-600">
        We're bootstrap-mode. The pricing model is services-first, software-second, and adapts to
        the engagement rather than the other way around. Indicative pricing is below, but we can
        tailor it to your needs. Reach out to us for a conversation.
      </p>

      <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <Badge variant="info">vDPO Retainer</Badge>
            <CardTitle className="mt-1">₹40k – ₹1.5L / month</CardTitle>
            <CardDescription>Founder-delivered, AI-agent-assisted fractional vDPO.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm text-slate-600">
              <li>· Monthly Board-grade posture report</li>
              <li>· DSAR fulfilment (up to 10/month)</li>
              <li>· Quarterly breach-readiness review</li>
              <li>· Quarterly policy & notice refresh</li>
              <li>· Continuous regulatory monitoring (Nazar)</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Badge variant="indigo">Readiness Assessment</Badge>
            <CardTitle className="mt-1">₹75k – ₹3L one-time</CardTitle>
            <CardDescription>Structured gap assessment + prioritised report.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm text-slate-600">
              <li>· Discovery + classification (Drishti + Vibhaag)</li>
              <li>· Scored against {CONTROL_LIBRARY_COUNT} controls (Parikshan)</li>
              <li>· Estimated statutory exposure</li>
              <li>· Remediation roadmap with effort estimates</li>
              <li>· Branded report + evidence pack (Prativedan)</li>
              <li>· 1 walkthrough call with the founder</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="border-gold-500">
          <CardHeader>
            <Badge variant="proof">Remediation Project</Badge>
            <CardTitle className="mt-1">Custom</CardTitle>
            <CardDescription>AI-agent-executed remediation with full audit trail.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm text-slate-600">
              <li>· Sudhaar-generated typed remediation plan</li>
              <li>· Dry-run diffs for every action</li>
              <li>· Generated rollback plans, validated</li>
              <li>· Karya executes after your approval</li>
              <li>· Customize Karya suitable to your estate</li>
              <li>· Continuous evidence + audit ledger</li>
              <li>· Priced per-action, not per-seat</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="mt-12 text-center">
        <Button variant="accent" size="lg" asChild={false}>
          <Link href="/#gap-scan">Start with the free gap-scan</Link>
        </Button>
      </div>
    </main>
  );
}
