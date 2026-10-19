import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import { OnboardingForm } from './onboarding-form';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <div className="w-full min-w-0 space-y-4 animate-fade-in">
      <PageHeader
        title="Onboard New Organization"
        module={moduleBarProps('onboarding')}
        meta={
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium text-[#D6DBE8]">
            Deployment region requires verification
          </span>
        }
        description="Record an organization for DPDPA assessment. Verify tenant membership, audit records, deployment location and assessment results in their dedicated workspaces after creation."
      />

      <OnboardingForm
        userId={user.id}
        userEmail={user.email ?? ''}
        userFullName={user.user_metadata?.full_name ?? ''}
      />
    </div>
  );
}
