import { redirect } from 'next/navigation';
import { requireTenantContext } from '@/lib/tenant-context';
import { BRAND } from '@axiom/config';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { supabase } = await requireTenantContext();
  // The page renders profile details (display name, last sign-in) that live on
  // the auth user rather than on the tenant context.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-[1120px] space-y-5 animate-fade-in">
      {/* Design System Hero Banner */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] to-[#243356] p-6 sm:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 mb-2.5">
          <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-semibold text-[#04322d] tracking-wide">
            P0
          </span>
          <span className="text-[11px] text-[#0FB5A5] font-medium">System Configuration</span>
          <span className="text-[11px] text-[#8a97b8]">Autonomy · Admin Enforced</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-heading text-2xl sm:text-[26px] font-bold text-white tracking-tight">
            Settings & Preferences
          </h1>
          <span className="font-heading text-lg sm:text-[18px] text-[#0FB5A5]">
            सेटिंग्स एवं विन्यास
          </span>
        </div>
        <p className="mt-2 text-[13px] text-[#c7cfe0] max-w-3xl leading-relaxed">
          Account security, tenant membership, cryptographic verification keys, and sovereign data
          residency preferences strictly constrained to ap-south-1.
        </p>
        <div className="mt-3.5 inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1 text-[11px] text-slate-200">
          <span className="text-[#C9A227]">◆</span> Sold standalone or bundled · module M0.1
        </div>
      </div>

      {/* 2 Main Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account Card */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3">
            Account & Session Identity
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Email</span>
              <span className="font-medium text-[12.5px] text-[#1E2A4A]">{user.email}</span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Full Name</span>
              <span className="font-medium text-[12.5px] text-[#1E2A4A]">
                {typeof user.user_metadata?.full_name === 'string'
                  ? user.user_metadata.full_name
                  : 'Compliance Lead'}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">User ID</span>
              <span className="font-mono text-[11px] text-slate-500">{user.id.slice(0, 18)}…</span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Last Authentication</span>
              <span className="text-[11.5px] text-[#1E2A4A]">
                {user.last_sign_in_at
                  ? new Date(user.last_sign_in_at).toLocaleDateString('en-IN')
                  : 'Active session'}
              </span>
            </div>
          </div>
        </div>

        {/* Security & Sovereignty Card */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3">
            Security & Domestic Residency (ap-south-1)
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Data Residency Region</span>
              <span className="rounded bg-teal-50 px-2 py-0.5 font-mono text-[11.5px] font-semibold text-teal-700">
                {BRAND.dataResidencyRegion} (Mumbai)
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Cross-Border Egress</span>
              <span className="font-medium text-[12.5px] text-teal-700">
                Disabled (0 non-domestic hops)
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Model Gateway Redaction</span>
              <span className="font-medium text-[12.5px] text-teal-700">
                Enforced before LLM egress
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-[12.5px] text-[#5b6270]">Evidence Retention WORM</span>
              <span className="font-medium text-[12.5px] text-[#C9A227]">
                AWS S3 Object Lock Compliance
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
