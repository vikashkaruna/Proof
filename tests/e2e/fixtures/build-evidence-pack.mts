/** Synthetic crash-boundary producer; run with tsx outside Playwright's CJS transform. */
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildEvidencePack } from '../../../packages/report-kit/src/archive.ts';
const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('Fixture input and output paths required');
const input = z
  .object({
    manifestText: z.string(),
    expectedManifestSha256: z.string(),
    reviewText: z.string(),
    expectedReviewSha256: z.string(),
    evidenceId: z.uuid(),
    contentBase64: z.string(),
  })
  .strict()
  .parse(JSON.parse(await readFile(inputPath, 'utf8')));
const archive = buildEvidencePack({
  ...input,
  members: new Map([[input.evidenceId, Buffer.from(input.contentBase64, 'base64')]]),
});
await writeFile(outputPath, archive.archive, { mode: 0o600 });
process.stdout.write(
  JSON.stringify({ archiveSha256: archive.archiveSha256, byteSize: archive.byteSize }),
);
