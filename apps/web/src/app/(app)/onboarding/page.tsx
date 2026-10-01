import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { OnboardingForm } from './onboarding-form';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-[880px] space-y-6 animate-fade-in py-2">
      {/* Design System Hero Banner */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] to-[#243356] p-6 sm:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 mb-2.5">
          <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-semibold text-[#04322d] tracking-wide">
            P0
          </span>
          <span className="text-[11px] text-[#0FB5A5] font-medium">Enterprise Onboarding</span>
          <span className="text-[11px] text-[#8a97b8]">
            Deployment region requires verification
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-heading text-2xl sm:text-[26px] font-bold text-white tracking-tight">
            Onboard New Organization
          </h1>
          <span className="font-heading text-lg sm:text-[18px] text-[#0FB5A5]">
            संस्था ऑनबोर्डिंग
          </span>
        </div>
        <p className="mt-2 text-[13px] text-[#c7cfe0] max-w-2xl leading-relaxed">
          Record an organization for DPDPA assessment. Verify tenant membership, audit records,
          deployment location and assessment results in their dedicated workspaces after creation.
        </p>
      </div>

      <OnboardingForm
        userEmail={user.email ?? ''}
        userFullName={user.user_metadata?.full_name ?? ''}
      />
    </div>
  );
}
