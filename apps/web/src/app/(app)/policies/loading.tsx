/** Route-level loading state: the shape of the policies surface, honestly empty. */
export default function PoliciesLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-live="polite">
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-6">
        <div className="h-7 w-72 rounded bg-mist-100" />
        <div className="h-4 w-full max-w-2xl rounded bg-mist-100" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl border border-slate-200 bg-mist-50" />
        ))}
      </div>
      <div className="h-48 rounded-xl border border-slate-200 bg-mist-50" />
      <div className="h-40 rounded-xl border border-slate-200 bg-mist-50" />
      <span className="sr-only">Loading policy records</span>
    </div>
  );
}
