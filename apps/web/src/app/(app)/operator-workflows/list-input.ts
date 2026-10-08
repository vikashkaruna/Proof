export type ListDeclarationMode = 'list' | 'unknown' | 'none';

/** Blank is unknown. Only an explicit None selection can declare an empty list. */
export function parseListDeclaration(mode: string, value: string): string[] | null {
  if (mode === 'unknown') return null;
  if (mode === 'none') return [];
  if (mode !== 'list') throw new Error('Choose List, Unknown or None for this declaration.');
  if (!value.trim()) return null;
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => !item))
    throw new Error(
      'Enter named items separated by commas, or choose Unknown or None. Remove empty items.',
    );
  return items;
}
