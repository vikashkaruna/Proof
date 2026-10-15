/** Inspect exact retained bytes without normalizing them. Native parsing validates
 * JSON grammar; this bounded lexical pass additionally refuses duplicate decoded
 * member names at every object depth, including escaped spellings of the same key.
 */
export function parseCatalogueJson(text: string, maxBytes: number): unknown {
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new Error('Catalogue JSON exceeds byte limit');
  const value: unknown = JSON.parse(text);
  const stack: (Set<string> | null)[] = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 32) throw new Error('Catalogue JSON exceeds depth limit');
    } else if (token === '}' || token === ']') stack.pop();
    else {
      const keys = stack.at(-1);
      let next = match.index + token.length;
      while (next < text.length && /[\t\n\r ]/.test(text[next]!)) next++;
      if (keys && text[next] === ':') {
        const key: unknown = JSON.parse(token);
        if (typeof key !== 'string' || keys.has(key))
          throw new Error('Duplicate catalogue JSON key');
        keys.add(key);
      }
    }
  }
  return value;
}
