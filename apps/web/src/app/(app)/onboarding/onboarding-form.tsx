'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OnboardingOperation } from '@axiom/types';
import { useOnboardingOperation } from './use-onboarding-operation';

interface OnboardingFormProps {
  userId: string;
  userEmail: string;
  userFullName: string;
}

export function OnboardingForm({ userId, userEmail, userFullName }: OnboardingFormProps) {
  const router = useRouter();
  const operation = useOnboardingOperation(userId);
  const loading = operation.busy;
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

  const acceptProof = (proof: OnboardingOperation | null) => {
    if (!proof) return;
    if (proof.state === 'recorded') {
      document.cookie = `axiom_active_tenant=${proof.tenantId}; path=/; max-age=31536000; SameSite=Lax`;
      router.push(`/assessment?engagement=${encodeURIComponent(proof.engagementId)}`);
      router.refresh();
    } else if (proof.state === 'fenced') {
      setError(
        'The original request is closed without creating an organization. You may now review the fields and prepare a new request.',
      );
    } else if (proof.state === 'recorded_access_withdrawn') {
      setError(
        'The original organization was recorded. Your current account no longer has access to it. No new organization was created.',
      );
    } else
      setError(
        'The original request is still unconfirmed. Keep it and check again, or close it safely before preparing another.',
      );
  };
  const originalFields = () => ({
    name: formData.name.trim(),
    slug: formData.slug.trim() || null,
    tier:
      formData.tier === 'essential'
        ? ('essential' as const)
        : formData.tier === 'enterprise'
          ? ('enterprise' as const)
          : ('growth' as const),
    is_sdf: formData.is_sdf,
    processes_health_data: formData.processes_health_data,
    processes_children_data: formData.processes_children_data,
    dpo_name: formData.dpo_name.trim() || null,
    dpo_email: formData.dpo_email.trim() || null,
    systems: [],
  });
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!formData.name.trim()) {
      setError('Organization name is required.');
      return;
    }
    acceptProof(await operation.act('create', originalFields()));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {(error || operation.error) && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-medium text-red-800 animate-shake">
          {error || operation.error}
        </div>
      )}

      {operation.retained && (
        <section
          className="rounded-xl border border-slate-300 bg-slate-50 p-4 text-sm"
          aria-label="Original organization request"
        >
          <h2 className="font-semibold">Resolve your original organization request</h2>
          <p className="mt-1">
            Its reference is retained for this account. Check its saved outcome before preparing
            another organization. Names, DPO details and inventory are not stored in this browser
            journal.
          </p>
          <p className="mt-1">
            To resume the same request, re-enter its original fields. Changed fields require closing
            the original request first.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={loading}
              onClick={async () => acceptProof(await operation.act('read'))}
            >
              Check saved outcome
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={async () => acceptProof(await operation.act('fence', originalFields()))}
            >
              Close original request safely
            </button>
          </div>
        </section>
      )}
      {/* 1. Entity Profile Card */}
      <div className="rounded-2xl border border-[#e4e8ee] bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 border-b border-[#eef1f5] pb-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1E2A4A] text-xs font-bold text-white">
            1
          </span>
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A]">
            Organization &amp; Statutory Profile
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
            Data Protection Officer (DPO) &amp; Resident Contact (§8(4))
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
