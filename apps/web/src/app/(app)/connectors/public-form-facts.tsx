import type { PublicFormMetadata } from '@axiom/types';

/** Displays retained source attributes; never infers backend processing facts. */
export function PublicFormFacts({
  metadata,
  pageLabel,
  unavailable = false,
}: {
  metadata?: PublicFormMetadata;
  pageLabel: string;
  unavailable?: boolean;
}) {
  return (
    <section
      aria-label={`${pageLabel} static HTML forms`}
      className="space-y-1 break-normal text-slate-700"
    >
      <h4 className="font-medium text-indigo-900">Static HTML forms</h4>
      {unavailable ? (
        <p>Form inspection unavailable: this page could not be retrieved.</p>
      ) : !metadata ? (
        <p>Static HTML forms were not examined in this saved check.</p>
      ) : (
        <>
          <p>
            {metadata.observedFormCount} {metadata.observedFormCount === 1 ? 'form' : 'forms'}{' '}
            observed in retrieved static HTML.
          </p>
          {metadata.formsTruncated && (
            <p>
              Form details are truncated: {metadata.forms.length} of {metadata.observedFormCount}{' '}
              observed forms are recorded.
            </p>
          )}
          {metadata.forms.length > 0 && (
            <details className="rounded border border-slate-200 bg-white p-2">
              <summary className="cursor-pointer font-medium text-indigo-900">
                Inspect recorded form attributes
              </summary>
              <ol className="mt-2 space-y-3">
                {metadata.forms.map((form) => (
                  <li key={form.ordinal}>
                    <p className="font-medium">
                      Form {form.ordinal} · Method {form.method.toUpperCase()}
                    </p>
                    <p>
                      {form.observedControlCount} controls observed · {form.excludedControlCount}{' '}
                      excluded · {form.controls.length} control details recorded
                    </p>
                    {form.controlsTruncated && (
                      <p>
                        Control details are truncated; additional eligible controls were observed.
                      </p>
                    )}
                    <ul className="mt-1 list-inside list-disc">
                      {form.controls.map((control) => (
                        <li key={control.ordinal}>
                          Control {control.ordinal}: {control.element}
                          {control.inputType ? ` (${control.inputType})` : ''} · Required attribute:{' '}
                          {control.requiredAttribute ? 'present' : 'absent'} · Disabled attribute:{' '}
                          {control.disabledAttribute ? 'present' : 'absent'}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-slate-600">
                Excluded controls remain counted; their details are withheld.
              </p>
            </details>
          )}
          <p className="text-xs text-slate-600">
            HTML form attributes only. Dynamic controls, actual submissions, backend storage and
            processing locations are unverified.
          </p>
        </>
      )}
    </section>
  );
}
