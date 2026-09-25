/** Column/field-name hints only; a hint is a prompt for human review, not a finding. */
const NAME_HINTS: readonly [RegExp, string][] = [
  [/e_?mail/, 'contact'],
  [/phone|mobile|msisdn/, 'contact'],
  [/address|pincode|pin_code|postal|zip/, 'contact'],
  [
    /aadhaa?r|\bpan\b|pan_(no|number)|passport|voter|driving_?licen[cs]e|dob|date_of_birth|birth/,
    'identity',
  ],
  [/first_?name|last_?name|full_?name|^name$|surname/, 'identity'],
  [/account_?(no|number)|iban|ifsc|card|upi|salary|income/, 'financial'],
  [/diagnos|medical|health|blood|allerg|prescription/, 'health'],
  [/employee|designation|department|payroll/, 'employment'],
  [/guardian|parent|minor|child/, 'children'],
];
export function categoryHints(field: string): string[] {
  const name = field.toLowerCase();
  return [...new Set(NAME_HINTS.filter(([re]) => re.test(name)).map(([, key]) => key))].sort();
}

/** Value detectors. Only counts leave the adapter; matched values never do. */
const DETECTORS: readonly [string, RegExp][] = [
  ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['phone_in', /^(\+?91[\s-]?)?[6-9]\d{9}$/],
  ['pan', /^[A-Z]{5}\d{4}[A-Z]$/],
  ['aadhaar_like', /^[2-9]\d{3}\s?\d{4}\s?\d{4}$/],
];

/** Per-field shape counts over sampled values. Values are discarded here. */
export function profileField(
  field: string,
  values: readonly unknown[],
): {
  field: string;
  sampled: number;
  nonNull: number;
  detected: Record<string, number>;
  categoryHints: string[];
} {
  const detected: Record<string, number> = {};
  let nonNull = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    nonNull += 1;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    for (const [key, re] of DETECTORS) if (re.test(text)) detected[key] = (detected[key] ?? 0) + 1;
  }
  return { field, sampled: values.length, nonNull, detected, categoryHints: categoryHints(field) };
}
