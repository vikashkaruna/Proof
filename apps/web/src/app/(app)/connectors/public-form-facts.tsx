import type { PublicFormMetadata } from '@axiom/types';

function recordedControlTypes(controls: PublicFormMetadata['forms'][number]['controls']) {
  const counts = new Map<string, number>();
  for (const control of controls) {
    const label = control.element === 'input' ? `${control.inputType} input` : control.element;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}: ${count}`).join(' · ');
}

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
      <p className="text-sm font-medium text-indigo-900">
        {unavailable
          ? 'Page unavailable · Static forms not inspected'
          : metadata
            ? 'Page retrieved · Static forms inspected'
            : 'Page retrieved · Static forms unexamined'}
      </p>
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
          {metadata.observedFormCount === 0 && (
            <p>No static HTML form elements were observed on this inspected page.</p>
          )}
          {metadata.formsTruncated && (
            <p>
              Form details are truncated: {metadata.forms.length} of {metadata.observedFormCount}{' '}
              observed forms are recorded.
            </p>
          )}
          {metadata.forms.length > 0 && (
            <>
              <ol className="mt-2 space-y-3">
                {metadata.forms.map((form) => (
                  <li key={form.ordinal}>
                    <p className="font-medium">Form {form.ordinal}</p>
                    <p>
                      {form.observedControlCount} controls observed · {form.excludedControlCount}{' '}
                      excluded · {form.controls.length} control details recorded
                    </p>
                    <p>
                      Recorded control types:{' '}
                      {recordedControlTypes(form.controls) ||
                        'no eligible control details retained'}
                    </p>
                    {form.controlsTruncated && (
                      <p>
                        Control details are truncated; additional eligible controls were observed.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              <details className="mt-1 rounded border border-slate-200 bg-white p-2">
                <summary className="cursor-pointer font-medium text-indigo-900">
                  Inspect recorded form attributes
                </summary>
                <p className="text-xs text-slate-600">
                  GET is the HTML default when a method is absent or invalid. The saved facts do not
                  distinguish a declared method from a default; JavaScript submission behaviour is
                  unverified.
                </p>
                <ol className="mt-2 space-y-3">
                  {metadata.forms.map((form) => (
                    <li key={form.ordinal}>
                      <p>
                        Form {form.ordinal} · HTML recorded method (declared or default):{' '}
                        {form.method.toUpperCase()}
                      </p>
                      <ul className="mt-1 list-inside list-disc">
                        {form.controls.map((control) => (
                          <li key={control.ordinal}>
                            Control {control.ordinal}: {control.element}
                            {control.inputType ? ` (${control.inputType})` : ''} · Required
                            attribute: {control.requiredAttribute ? 'present' : 'absent'} · Disabled
                            attribute: {control.disabledAttribute ? 'present' : 'absent'}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </details>
              <p className="mt-2 text-xs text-slate-600">
                Excluded controls remain counted; their details are withheld. Exclusions can include
                buttons, hidden, password or file inputs, and controls with explicit form ownership.
                The exact exclusion reasons were not retained.
              </p>
            </>
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
