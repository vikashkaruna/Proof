'use client';

interface ErrorRecoveryProps {
  reset: () => void;
}

export function ErrorRecovery({ reset }: ErrorRecoveryProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F4F6F8] px-4 py-12 text-slate-700">
      <section
        role="alert"
        aria-labelledby="recovery-title"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <p className="font-heading text-lg font-semibold text-[#1E2A4A]">Axiom Proof</p>
        <h1 id="recovery-title" className="mt-5 font-heading text-2xl font-semibold text-[#1E2A4A]">
          This page could not load
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Please try again. If the problem continues, return to sign in and try later.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-[#1E2A4A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            Try again
          </button>
          <a
            href="/login"
            className="rounded-lg border border-slate-300 px-5 py-2.5 text-center text-sm font-semibold text-[#1E2A4A] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            Back to sign in
          </a>
        </div>
      </section>
    </main>
  );
}
