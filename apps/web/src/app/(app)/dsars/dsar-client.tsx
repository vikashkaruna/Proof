'use client';

import React, { useState } from 'react';
import { usePersistentState } from '@/lib/use-persistent-state';
import { AgentIcon } from '@axiom/ui';

export interface DsarItem {
  id: string;
  principal: string;
  email?: string;
  phone?: string;
  type: string;
  stage: number; // 0 to 4
  slaDays: number;
  systems: number;
  receivedAt: string;
  notes?: string;
}

export interface DsarClientProps {
  initialDsars: DsarItem[];
  stats: {
    accessCount: number;
    erasureCount: number;
    nearingSlaCount: number;
    fulfilledCount: number;
  };
}

const STAGES = ['Intake', 'Identity verification', 'Data location', 'Fulfilment', 'Delivered'];

export function DsarClient({ initialDsars, stats }: DsarClientProps) {
  // Stage changes persist across reloads. `usePersistentState` renders the
  // server-supplied list during SSR and hydration, then swaps to the stored
  // list without an effect — see the hook for why the effect had to go.
  const [dsarList, setDsarList] = usePersistentState<DsarItem[]>('axiom_dsar_items', initialDsars);

  // `selId` used to be mirrored state that an effect kept in step with the
  // list. It is a *derivation* of the list plus an optional user choice, so
  // holding null until the user picks removes the sync problem entirely
  // rather than solving it.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selId = pickedId ?? dsarList[0]?.id ?? '';
  const setSelId = setPickedId;

  // New DSAR Modal State
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newPrincipal, setNewPrincipal] = useState('');
  const [newType, setNewType] = useState('Access');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newSystems, setNewSystems] = useState(3);
  const [newNotes, setNewNotes] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const selectedDsar = dsarList.find((d) => d.id === selId) || dsarList[0];

  const handleAdvance = (id: string) => {
    setDsarList((prev) =>
      prev.map((d) => (d.id === id && d.stage < 4 ? { ...d, stage: d.stage + 1 } : d)),
    );
  };

  const handleCreateDsar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPrincipal.trim()) return;

    const newId = `DSAR-2026-0${Math.floor(90 + Math.random() * 900)}`;
    const created: DsarItem = {
      id: newId,
      principal: newPrincipal.trim(),
      type: newType,
      email: newEmail.trim() || undefined,
      phone: newPhone.trim() || undefined,
      stage: 0,
      slaDays: 30,
      systems: Number(newSystems) || 3,
      receivedAt: 'Just now',
      notes: newNotes.trim() || undefined,
    };

    setDsarList((prev) => [created, ...prev]);
    setSelId(newId);

    setNewModalOpen(false);
    setNewPrincipal('');
    setNewEmail('');
    setNewPhone('');
    setNewNotes('');
    setToastMessage(`DSAR ${newId} for ${created.principal} successfully logged into intake.`);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const currentStage = selectedDsar?.stage ?? 0;

  const stageDetails = [
    'Request logged, deduplicated against open requests',
    'Verifying principal via OTP + DigiLocker / Aadhaar e-KYC',
    `Drishti locates personal data across ${selectedDsar?.systems || 3} systems`,
    'Compiling / erasing data across located storage targets',
    'Response delivered to principal; proof sealed into vault by Saakshi',
  ];

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER                                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P3 · M2.8
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="drishti" size="xs" variant="on-dark" state="working" />
                  <span>Drishti</span>
                </span>
                <span className="text-[#0FB5A5]/70">+</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="saakshi" size="xs" variant="on-dark" state="idle" />
                  <span>Saakshi</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Autonomy L2</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                DPDPA §11 & Rule 16
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                DSAR / Rights Requests
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">अधिकार अनुरोध</span>
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[#c7cfe0]">
              Intake, identity verification workflow, fulfilment tracking, statutory-clock
              monitoring and response generation for data-principal rights requests.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setNewModalOpen(true)}
              className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] text-white text-xs font-bold py-2.5 px-4 shadow-sm transition-all cursor-pointer"
            >
              + Log new DSAR
            </button>
          </div>
        </div>
      </div>

      {toastMessage && (
        <div className="flex items-center justify-between rounded-xl border border-teal-300 bg-[#E5FAF7] p-3 text-xs text-[#04322d] shadow-sm animate-in fade-in-0 duration-150">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span className="font-semibold">{toastMessage}</span>
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="text-xs font-bold opacity-60 hover:opacity-100 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. OPEN REQUESTS & THIS MONTH CARDS                          */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A] mb-3">Open requests</h2>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Access requests</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {stats.accessCount}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#C9A227]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Erasure requests</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {stats.erasureCount}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#D9534F]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">
                Nearing SLA (≤3 days)
              </span>
              <span className="font-mono text-xs font-semibold text-[#D9534F]">
                {stats.nearingSlaCount}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A] mb-3">This month</h2>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#0FB5A5]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Fulfilled on time</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {stats.fulfilledCount}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Avg turnaround</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">4.2 days</span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#0FB5A5]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Identity verified</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">100%</span>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. MAIN 2-COLUMN DSAR INTERFACE: LIST + WORKFLOW STEPPER     */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start">
        {/* Left: DSARs List */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
          <div className="flex items-center justify-between px-5 py-3 border-b border-[#e4e8ee] bg-[#F4F6F8]">
            <span className="font-heading text-xs font-semibold text-[#1E2A4A] uppercase tracking-wider">
              Data Principal Requests ({dsarList.length})
            </span>
            <span className="text-[11px] text-slate-500 font-mono">30-day statutory clock</span>
          </div>

          <div className="divide-y divide-[#eef1f5]">
            {dsarList.map((d) => {
              const isSelected = selectedDsar?.id === d.id;
              const isFulfilled = d.stage >= 4;
              const isUrgent = !isFulfilled && d.slaDays <= 3;
              const typeColor =
                d.type === 'Erasure'
                  ? 'bg-[#FCEEEC] text-[#D9534F]'
                  : 'bg-[#e6f7f5] text-[#0a8d80]';

              return (
                <div
                  key={d.id}
                  onClick={() => setSelId(d.id)}
                  className={`flex items-center gap-3 p-4 cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[#F4F6F8] border-l-4 border-l-[#0FB5A5]'
                      : 'hover:bg-slate-50/70 border-l-4 border-l-transparent'
                  }`}
                >
                  <div className="h-9 w-9 rounded-full bg-[#1E2A4A] text-white flex items-center justify-center font-heading text-sm font-bold shrink-0">
                    {d.principal.charAt(0)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[#1E2A4A]">{d.principal}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${typeColor}`}>
                        {d.type}
                      </span>
                    </div>
                    <div className="font-mono text-[10.5px] text-slate-400 mt-0.5">
                      {d.id} · {d.systems} systems · {STAGES[d.stage]}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={`text-xs font-semibold ${
                        isFulfilled
                          ? 'text-[#0a8d80]'
                          : isUrgent
                            ? 'text-[#D9534F]'
                            : 'text-slate-600'
                      }`}
                    >
                      {isFulfilled ? 'fulfilled' : `${d.slaDays}d to SLA`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Selected DSAR 5-Stage Stepper (Sticky) */}
        {selectedDsar && (
          <div className="sticky top-4 rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
            <div className="p-5 border-b border-[#e4e8ee]">
              <div className="flex items-center justify-between">
                <h3 className="font-heading text-base font-semibold text-[#1E2A4A]">
                  {selectedDsar.principal}
                </h3>
                <span
                  className={`text-[9px] font-bold px-2 py-0.5 rounded ${
                    selectedDsar.type === 'Erasure'
                      ? 'bg-[#FCEEEC] text-[#D9534F]'
                      : 'bg-[#e6f7f5] text-[#0a8d80]'
                  }`}
                >
                  {selectedDsar.type}
                </span>
              </div>
              <div className="font-mono text-[10.5px] text-slate-400 mt-1">
                {selectedDsar.id} · {selectedDsar.systems} systems ·{' '}
                {selectedDsar.stage >= 4 ? 'fulfilled' : `${selectedDsar.slaDays}d to SLA`}
              </div>
            </div>

            <div className="p-5 space-y-4">
              {STAGES.map((label, idx) => {
                const done = idx < currentStage;
                const active = idx === currentStage;
                const notLast = idx !== STAGES.length - 1;

                const dotBg = done ? '#0FB5A5' : active ? '#C9A227' : '#e2e8f0';
                const dotColor = done || active ? '#04322d' : '#8a909b';
                const mark = done ? '✓' : String(idx + 1);

                return (
                  <div key={label} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        style={{ backgroundColor: dotBg, color: dotColor }}
                        className="h-6 w-6 rounded-full flex items-center justify-center font-heading text-xs font-bold shrink-0"
                      >
                        {mark}
                      </span>
                      {notLast && <span className="w-0.5 flex-1 bg-slate-200 my-1 min-h-[16px]" />}
                    </div>

                    <div className="flex-1 pb-1">
                      <div
                        className={`text-xs font-semibold ${
                          done || active ? 'text-[#1E2A4A]' : 'text-slate-400'
                        }`}
                      >
                        {label}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                        {stageDetails[idx]}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => handleAdvance(selectedDsar.id)}
                  disabled={currentStage >= 4}
                  className={`w-full py-2.5 rounded-lg text-xs font-semibold transition-all ${
                    currentStage >= 4
                      ? 'bg-[#E5FAF7] text-[#0a6b61] cursor-default'
                      : 'bg-[#1E2A4A] hover:bg-[#283863] text-white cursor-pointer shadow-xs'
                  }`}
                >
                  {currentStage >= 4
                    ? '✓ Fulfilled & delivered'
                    : `Advance to: ${STAGES[currentStage + 1]}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* 4. NEW DSAR INTAKE MODAL                                     */}
      {/* ============================================================ */}
      {newModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 duration-150 backdrop-blur-xs overflow-y-auto">
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 my-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-[#0FB5A5] text-lg font-bold">+</span>
                <h3 className="text-base font-bold text-[#1E2A4A]">Log New DSAR Request</h3>
              </div>
              <button
                type="button"
                onClick={() => setNewModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Log a statutory Data Principal Rights request under DPDPA 2023 §11–§14. Initiates the
              30-day compliance SLA clock.
            </p>

            <form onSubmit={handleCreateDsar} className="space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-slate-700">
                  Data Principal Full Name *
                </label>
                <input
                  type="text"
                  required
                  value={newPrincipal}
                  onChange={(e) => setNewPrincipal(e.target.value)}
                  placeholder="e.g. Priya Sengupta"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700">Request Type *</label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                  >
                    <option value="Access">Access (§11)</option>
                    <option value="Erasure">Erasure (§12)</option>
                    <option value="Correction">Correction (§12)</option>
                    <option value="Nomination">Nomination (§14)</option>
                    <option value="Grievance">Grievance (§13)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700">Target Systems</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={newSystems}
                    onChange={(e) => setNewSystems(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">Contact Email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="priya.sengupta@example.com"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">
                  Mobile Phone (e-KYC / OTP)
                </label>
                <input
                  type="tel"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">
                  Request Scope & Notes
                </label>
                <textarea
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Specific accounts, transaction records, or telemetry to retrieve or purge..."
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setNewModalOpen(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer"
                >
                  Log DSAR & Start 30d Clock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
