import { formatDate } from '@/lib/display-time';
import { redirect } from 'next/navigation';
import { requireTenantContext } from '@/lib/tenant-context';
import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { supabase, role } = await requireTenantContext();
  // The page renders profile details (display name, last sign-in) that live on
  // the auth user rather than on the tenant context.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="w-full min-w-0 space-y-4 animate-fade-in">
      <PageHeader
        title="Settings"
        module={moduleBarProps('settings')}
        description="Review account identity and tenant membership. Deployment, gateway and storage assurances require separate operational verification."
      />

      {can(Capability.USER_MANAGE, { role }) && (
        <section
          aria-labelledby="members-settings-heading"
          className="flex flex-col gap-4 rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div className="max-w-2xl">
            <h2
              id="members-settings-heading"
              className="font-heading text-base font-semibold text-[#1E2A4A]"
            >
              Members &amp; invitations
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[#5b6270]">
              Invite people, review who has access, and manage pending invitations for this
              organisation.
            </p>
          </div>
          <Link
            href="/settings/members"
            className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Manage members and invitations
          </Link>
        </section>
      )}

      <section
        aria-labelledby="custody-settings-heading"
        className="flex flex-col gap-4 rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div className="max-w-2xl">
          <h2
            id="custody-settings-heading"
            className="font-heading text-base font-semibold text-[#1E2A4A]"
          >
            Local dispatch-key custody
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-[#5b6270]">
            Review tenant-scoped owner requests, founder approvals, nominated operator activation
            and periodic reminders.
          </p>
          <ol
            aria-label="Custody policy steps"
            className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-[#1E2A4A]"
          >
            {['Owner requests', 'Founder approves', 'Operator activates'].map((step, index) => (
              <li
                key={step}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#e4e8ee] bg-slate-50 px-2.5 py-1"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-900 text-[10px] text-white"
                >
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
        <Link
          href="/settings/local-custody"
          className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          Manage local custody policies
        </Link>
      </section>

      {/* 2 Main Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account Card */}
        <div className="min-w-0 rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3">
            Account & Session Identity
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Email</span>
              <span className="min-w-0 break-all font-medium text-[12.5px] text-[#1E2A4A] sm:text-right">
                {user.email}
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Full Name</span>
              <span className="min-w-0 break-words font-medium text-[12.5px] text-[#1E2A4A] sm:text-right">
                {typeof user.user_metadata?.full_name === 'string'
                  ? user.user_metadata.full_name
                  : 'Not provided'}
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">User ID</span>
              <span className="min-w-0 break-all font-mono text-[11px] text-slate-500 sm:text-right">
                {user.id.slice(0, 18)}…
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Last Authentication</span>
              <span className="min-w-0 text-[11.5px] text-[#1E2A4A] sm:text-right">
                {user.last_sign_in_at ? formatDate(user.last_sign_in_at) : 'Unavailable'}
              </span>
            </div>
          </div>
          <Link
            href="/settings/security"
            className="mt-4 inline-flex text-sm font-medium text-teal-700 underline underline-offset-2 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
          >
            Manage authenticator and recovery codes
          </Link>
        </div>

        {/* Security & Sovereignty Card */}
        <div className="min-w-0 rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3">
            Operational assurance
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Data Residency Region</span>
              <span className="min-w-0 break-words rounded bg-teal-50 px-2 py-0.5 font-mono text-[11.5px] font-semibold text-teal-700 sm:text-right">
                Verify in deployment records
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Cross-Border Egress</span>
              <span className="min-w-0 break-words font-medium text-[12.5px] text-teal-700 sm:text-right">
                Unverified in this view
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Model Gateway Redaction</span>
              <span className="min-w-0 break-words font-medium text-[12.5px] text-teal-700 sm:text-right">
                Unverified in this view
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1 py-2.5 sm:grid-cols-2 sm:gap-3">
              <span className="text-[12.5px] text-[#5b6270]">Evidence Retention WORM</span>
              <span className="min-w-0 break-words font-medium text-[12.5px] text-slate-700 sm:text-right">
                Verify with the exact stored object version
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
