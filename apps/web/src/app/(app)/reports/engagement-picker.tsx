'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { reportRequest } from './report-request';
import { button, field, failure } from './report-ui';
const choiceSchema = z.object({ id: z.uuid(), title: z.string(), libraryVersion: z.string() });
const choicesSchema = z.object({
  data: z.array(choiceSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
  }),
  currentLibraryVersion: z.string().nullable(),
});
type Choice = z.infer<typeof choiceSchema>;

/** Scope is a real tenant record, selected by title; IDs remain server-facing values. */
export function EngagementPicker({
  tenantId,
  disabled,
  onChanged,
  onReady,
}: {
  tenantId: string;
  disabled: boolean;
  onChanged: () => void;
  onReady: (ready: boolean) => void;
}) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selection, setSelection] = useState<{ tenantId: string; choice: Choice } | null>(null);
  const [currentLibrary, setCurrentLibrary] = useState<string | null>(null);
  const [page, setPage] = useState({ tenantId, offset: 0 });
  const [more, setMore] = useState(false);
  const [requestLoading, setRequestLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceTenant, setSourceTenant] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const offset = page.tenantId === tenantId ? page.offset : 0;
  const loading = requestLoading || sourceTenant !== tenantId;
  const visibleError = sourceTenant === tenantId ? error : '';
  const visibleChoices = sourceTenant === tenantId ? choices : [];
  const visibleLibrary = sourceTenant === tenantId ? currentLibrary : null;
  const selected = selection?.tenantId === tenantId ? selection.choice : null;
  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(tenantId, `/evidence-packs/options/engagements?limit=20&offset=${offset}`, {
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((value) => {
        if (controller.signal.aborted) return;
        const result = choicesSchema.parse(value);
        setChoices(result.data);
        setMore(result.meta.hasMore);
        setCurrentLibrary(result.currentLibraryVersion);
        setSourceTenant(tenantId);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure(err));
          setSourceTenant(tenantId);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRequestLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, offset, revision]);
  useEffect(() => {
    onReady(!loading && !visibleError && (!!selected || !!visibleLibrary));
  }, [loading, visibleError, selected, visibleLibrary, onReady]);
  function reload(next: number) {
    setPage({ tenantId, offset: next });
    setRequestLoading(true);
    setError('');
    setChoices([]);
    setRevision((v) => v + 1);
  }
  const options =
    selected && !visibleChoices.some((c) => c.id === selected.id)
      ? [selected, ...visibleChoices]
      : visibleChoices;
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        Engagement scope
        <select
          name="engagementId"
          className={`${field} mt-1`}
          value={selected?.id ?? ''}
          disabled={disabled || loading || !!visibleError}
          onChange={(event) => {
            const choice = options.find((c) => c.id === event.target.value);
            setSelection(choice ? { tenantId, choice } : null);
            onChanged();
          }}
        >
          <option value="" disabled={!visibleLibrary}>
            {visibleLibrary
              ? `No engagement — current library ${visibleLibrary}`
              : 'Choose an engagement'}
          </option>
          {options.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.title} · {choice.libraryVersion}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p role="status" className="text-sm">
          Loading engagement choices…
        </p>
      ) : visibleError ? (
        <p role="alert" className="text-sm text-[#D9534F]">
          {visibleError}
        </p>
      ) : !visibleLibrary ? (
        <p className="text-xs text-slate-600">
          No current control library is published. Choose an engagement to use its recorded library.
        </p>
      ) : null}
      {selected && (
        <p className="text-xs text-slate-600">
          Selected: {selected.title} · Library {selected.libraryVersion}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={disabled || loading || offset === 0}
          onClick={() => reload(Math.max(0, offset - 20))}
        >
          Previous engagements
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled || loading || !!visibleError || !more}
          onClick={() => reload(offset + 20)}
        >
          Next engagements
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled || loading}
          onClick={() => reload(offset)}
        >
          Refresh engagements
        </button>
      </div>
    </div>
  );
}
