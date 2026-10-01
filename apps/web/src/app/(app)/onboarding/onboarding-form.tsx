'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

interface OnboardingFormProps {
  userEmail: string;
  userFullName: string;
}

export function OnboardingForm({ userEmail, userFullName }: OnboardingFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    tier: 'growth',
    is_sdf: false,
    processes_health_data: false,
    processes_children_data: false,
    dpo_name: userFullName || 'Compliance Officer',
    dpo_email: userEmail || 'dpo@enterprise.co.in',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError('Organization name is required.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const payload = {
        name: formData.name.trim(),
        slug: formData.slug.trim() || undefined,
        tier: formData.tier,
        is_sdf: formData.is_sdf,
        processes_health_data: formData.processes_health_data,
        processes_children_data: formData.processes_children_data,
        dpo_name: formData.dpo_name,
        dpo_email: formData.dpo_email,
      };

      const res = await fetch('/api/bff/v1/organizations/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Onboarding failed');
      }

      // Switch active tenant cookie to the new tenant's ID
      if (data.tenant?.id) {
        document.cookie = `axiom_active_tenant=${data.tenant.id}; path=/; max-age=31536000; SameSite=Lax`;
      }

      // Force refresh and redirect to dashboard
      router.push('/dashboard');
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'An unexpected error occurred during onboarding.',
      );
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-medium text-red-800 animate-shake">
          {error}
        </div>
      )}

      {/* 1. Entity Profile Card */}
      <div className="rounded-2xl border border-[#e4e8ee] bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 border-b border-[#eef1f5] pb-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1E2A4A] text-xs font-bold text-white">
            1
          </span>
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A]">
            Organization & Statutory Profile
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="organization-name"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              Organization Legal Name *
            </label>
            <input
              id="organization-name"
              type="text"
              required
              placeholder="e.g. Zenith Financial Technologies Pvt Ltd"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full rounded-lg border border-[#d8dfe7] px-3 py-2 text-xs text-[#1E2A4A] focus:border-[#0FB5A5] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="organization-slug"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              Tenant Slug (Optional)
            </label>
            <input
              id="organization-slug"
              type="text"
              placeholder="e.g. zenith-fin (auto-generated if blank)"
              value={formData.slug}
              onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
              className="w-full rounded-lg border border-[#d8dfe7] px-3 py-2 text-xs text-[#1E2A4A] focus:border-[#0FB5A5] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="organization-tier"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              Subscription Tier
            </label>
            <select
              id="organization-tier"
              value={formData.tier}
              onChange={(e) => setFormData({ ...formData, tier: e.target.value })}
              className="w-full rounded-lg border border-[#d8dfe7] px-3 py-2 text-xs text-[#1E2A4A] focus:border-[#0FB5A5] focus:outline-none"
            >
              <option value="essential">Essential (Phase 1 Retainer)</option>
              <option value="growth">Growth (Continuous Compliance · Recommended)</option>
              <option value="enterprise">Enterprise (Significant Data Fiduciary Full Pack)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="organization-residency"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              Data Residency Boundary
            </label>
            <input
              id="organization-residency"
              type="text"
              disabled
              value="Deployment region must be verified from the active environment"
              className="w-full rounded-lg border border-[#eef1f5] bg-[#F4F6F8] px-3 py-2 text-xs text-[#5b6270]"
            />
          </div>
        </div>

        {/* DPDPA Statutory Classifications */}
        <div className="pt-2 border-t border-[#eef1f5]">
          <div className="text-xs font-semibold text-[#1E2A4A] mb-2.5">
            DPDPA Statutory Classifications
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex items-start gap-2.5 rounded-xl border border-[#e4e8ee] p-3 hover:bg-[#F9FAFB] cursor-pointer">
              <input
                type="checkbox"
                checked={formData.is_sdf}
                onChange={(e) => setFormData({ ...formData, is_sdf: e.target.checked })}
                className="mt-0.5 rounded text-[#0FB5A5] focus:ring-[#0FB5A5]"
              />
              <div className="text-left">
                <div className="text-xs font-semibold text-[#2F3542]">SDF Status (§10)</div>
                <div className="text-[10px] text-[#8a909b]">
                  Significant Data Fiduciary threshold
                </div>
              </div>
            </label>

            <label className="flex items-start gap-2.5 rounded-xl border border-[#e4e8ee] p-3 hover:bg-[#F9FAFB] cursor-pointer">
              <input
                type="checkbox"
                checked={formData.processes_health_data}
                onChange={(e) =>
                  setFormData({ ...formData, processes_health_data: e.target.checked })
                }
                className="mt-0.5 rounded text-[#0FB5A5] focus:ring-[#0FB5A5]"
              />
              <div className="text-left">
                <div className="text-xs font-semibold text-[#2F3542]">Health Data</div>
                <div className="text-[10px] text-[#8a909b]">Biometric / EHR health processing</div>
              </div>
            </label>

            <label className="flex items-start gap-2.5 rounded-xl border border-[#e4e8ee] p-3 hover:bg-[#F9FAFB] cursor-pointer">
              <input
                type="checkbox"
                checked={formData.processes_children_data}
                onChange={(e) =>
                  setFormData({ ...formData, processes_children_data: e.target.checked })
                }
                className="mt-0.5 rounded text-[#0FB5A5] focus:ring-[#0FB5A5]"
              />
              <div className="text-left">
                <div className="text-xs font-semibold text-[#2F3542]">Children Data (§9)</div>
                <div className="text-[10px] text-[#8a909b]">
                  Verifiable parental consent required
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* 2. DPO Contact Card */}
      <div className="rounded-2xl border border-[#e4e8ee] bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 border-b border-[#eef1f5] pb-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#0FB5A5] text-xs font-bold text-white">
            2
          </span>
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A]">
            Data Protection Officer (DPO) & Resident Contact (§8(4))
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="organization-dpo-name"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              DPO Full Name
            </label>
            <input
              id="organization-dpo-name"
              type="text"
              required
              value={formData.dpo_name}
              onChange={(e) => setFormData({ ...formData, dpo_name: e.target.value })}
              className="w-full rounded-lg border border-[#d8dfe7] px-3 py-2 text-xs text-[#1E2A4A] focus:border-[#0FB5A5] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="organization-dpo-email"
              className="block text-xs font-medium text-[#2F3542] mb-1"
            >
              DPO Official Email
            </label>
            <input
              id="organization-dpo-email"
              type="email"
              required
              value={formData.dpo_email}
              onChange={(e) => setFormData({ ...formData, dpo_email: e.target.value })}
              className="w-full rounded-lg border border-[#d8dfe7] px-3 py-2 text-xs text-[#1E2A4A] focus:border-[#0FB5A5] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Submit Button */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-xl border border-[#d8dfe7] px-4 py-2.5 text-xs font-semibold text-[#5b6270] hover:bg-[#F4F6F8] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-xl bg-[#0FB5A5] px-6 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-[#0da294] transition-colors disabled:opacity-60"
        >
          {loading ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <span>Creating organization...</span>
            </>
          ) : (
            <span>Complete organization setup →</span>
          )}
        </button>
      </div>
    </form>
  );
}
