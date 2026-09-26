import type { DryRunChange } from '@/lib/execution-view';
import { renderDiffValue } from '@/lib/execution-view';

/**
 * Renders the dry-run simulator's field-level diff (Doc 04 §3.2) as a
 * before → after table. The values are the simulator's declared-parameter
 * renderings — placeholders like `value_as_stored` are its honesty about not
 * reading real estate data, and are shown exactly as recorded.
 */
export function DryRunDiffView({ changes }: { changes: DryRunChange[] }) {
  if (changes.length === 0) {
    return (
      <p className="rounded-md bg-mist-50 p-3 text-xs text-slate-500">
        The simulation succeeded and produced no field-level changes.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full text-left text-xs">
        <thead className="bg-mist-100 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Field
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Before
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              After
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {changes.map((change) => (
            <tr key={change.field} className="bg-white">
              <td className="px-3 py-2 align-top">
                <code className="font-mono text-[11px] text-indigo-700">{change.field}</code>
                {change.role && (
                  <span className="ml-2 rounded bg-mist-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                    role: {change.role}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 align-top font-mono text-[11px] text-slate-500">
                {renderDiffValue(change.before)}
              </td>
              <td className="px-3 py-2 align-top font-mono text-[11px] font-medium text-slate-800">
                {renderDiffValue(change.after)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
