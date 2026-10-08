'use client';
import { useId, useRef, useState } from 'react';
import type { ListDeclarationMode } from './list-input';

const input =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50';
export function ListInputField({
  name,
  label,
  error,
  onChange,
}: {
  name: string;
  label: string;
  error?: string;
  onChange: () => void;
}) {
  const id = useId();
  const values = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ListDeclarationMode>('list');
  return (
    <div className="space-y-2 text-sm font-medium text-slate-700">
      <label className="block" htmlFor={`${id}-mode`}>
        {label} declaration
      </label>
      <select
        id={`${id}-mode`}
        name={`${name}Declaration`}
        className={input}
        value={mode}
        onChange={(event) => {
          setMode(event.target.value as ListDeclarationMode);
          if (values.current) values.current.value = '';
          onChange();
        }}
      >
        <option value="list">List (blank remains unknown)</option>
        <option value="unknown">Unknown</option>
        <option value="none">None — explicitly declared</option>
      </select>
      <label className="block" htmlFor={`${id}-values`}>
        {label}, separated by commas (unknown if blank)
      </label>
      <input
        ref={values}
        id={`${id}-values`}
        name={name}
        className={input}
        disabled={mode !== 'list'}
        maxLength={4000}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : `${id}-help`}
        onChange={onChange}
      />
      <p id={`${id}-help`} className="text-xs font-normal text-slate-500">
        {mode === 'none'
          ? 'This explicitly records none. It remains a human declaration requiring review.'
          : 'Blank or Unknown does not establish that there are none.'}
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-normal text-ember-700">
          {error}
        </p>
      )}
    </div>
  );
}
