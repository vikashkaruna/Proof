'use client';

import type { PublicAgentObservation, PublicSourcePreview } from '@axiom/types';
import { PublicFormFacts } from '../connectors/public-form-facts';

export function SourceProjectionView({ preview }: { preview: PublicSourcePreview }) {
  return (
    <section
      aria-label="Retained public source"
      className="space-y-3 rounded-xl border border-slate-200 p-4"
    >
      <h3 className="font-semibold text-[#1E2A4A]">Retained public HTML facts</h3>
      <p className="text-sm text-slate-600">
        These saved pages describe static HTML only. Private hosting, backend personal data and
        cross-border processing remain unknown.
      </p>
      <p className="break-all text-xs text-slate-600">
        Check <code>{preview.runtime_binding.check_id}</code> · Projection{' '}
        <code>{preview.runtime_binding.projection_sha256}</code>
      </p>
      {preview.creation_receipt && (
        <p className="text-sm">Binding receipt: {preview.creation_receipt}</p>
      )}
      {preview.projection.pages.map((page) => (
        <div key={page.page} className="space-y-1 rounded-lg bg-slate-50 p-3">
          <h4 className="font-medium capitalize">{page.page}</h4>
          <PublicFormFacts
            metadata={page.form_metadata}
            pageLabel={page.page}
            unavailable={page.status === 'unavailable'}
          />
          {page.content_sha256 && (
            <p className="break-all text-xs text-slate-600">
              Content SHA-256: <code>{page.content_sha256}</code>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

export function SourceResultView({ observation }: { observation: PublicAgentObservation }) {
  const drishti = observation.agent === 'drishti' ? observation.output.observation : null;
  const vibhaag = observation.agent === 'vibhaag' ? observation.output : null;
  return (
    <section
      aria-label="Retained agent result"
      className="space-y-3 rounded-xl border border-slate-200 p-4"
    >
      <h3 className="font-semibold text-[#1E2A4A]">
        {drishti ? 'Drishti public observation' : 'Vibhaag structural indicators'}
      </h3>
      <p className="text-sm font-medium text-[#1E2A4A]">Human review pending</p>
      <p className="text-sm text-slate-600">
        Private hosting: unknown · Backend personal data: unknown · Cross-border processing:
        unknown. This result does not close an assessment or confirm a personal-data classification.
      </p>
      {drishti?.pages.map((page) => (
        <div key={page.page} className="rounded-lg bg-slate-50 p-3">
          <h4 className="font-medium capitalize">{page.page}</h4>
          <PublicFormFacts
            metadata={page.form_metadata}
            pageLabel={page.page}
            unavailable={page.form_state === 'unavailable'}
          />
        </div>
      ))}
      {vibhaag && (
        <>
          {vibhaag.indicators.length ? (
            <ul className="space-y-2 text-sm">
              {vibhaag.indicators.map((item) => (
                <li
                  key={`${item.page}/${item.form_ordinal}/${item.control_ordinal}`}
                  className="rounded-lg bg-slate-50 p-3"
                >
                  Potential contact collection · {item.page} · form {item.form_ordinal}, control{' '}
                  {item.control_ordinal} · {item.input_type} input · requires human review
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">
              No email or telephone structural indicators in the observed static forms. This does
              not prove personal data is absent.
            </p>
          )}
          {vibhaag.unexamined_pages.length > 0 && (
            <p className="text-sm">Unexamined pages: {vibhaag.unexamined_pages.join(', ')}.</p>
          )}
          {vibhaag.unavailable_pages.length > 0 && (
            <p className="text-sm">Unavailable pages: {vibhaag.unavailable_pages.join(', ')}.</p>
          )}
        </>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">
          Review retained receipts and hashes
        </summary>
        <dl className="mt-2 grid gap-2 break-all sm:grid-cols-[auto_1fr]">
          <dt>Observation</dt>
          <dd>
            <code>{observation.observation_id}</code>
          </dd>
          <dt>Run</dt>
          <dd>
            <code>{observation.run_id}</code>
          </dd>
          <dt>Dispatch</dt>
          <dd>
            <code>{observation.dispatch_id}</code>
          </dd>
          <dt>Binding</dt>
          <dd>
            <code>{observation.binding_id}</code>
          </dd>
          <dt>Completion receipt</dt>
          <dd>{observation.completion_receipt}</dd>
          <dt>Output SHA-256</dt>
          <dd>
            <code>{observation.output_sha256}</code>
          </dd>
        </dl>
      </details>
    </section>
  );
}
