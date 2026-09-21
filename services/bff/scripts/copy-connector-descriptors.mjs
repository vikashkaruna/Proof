import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const source = new URL('../src/connectors/descriptors/', import.meta.url);
const destination = new URL('../dist/connectors/descriptors/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(source)) {
  if (name.endsWith('.yaml')) cpSync(new URL(name, source), new URL(name, destination));
}
