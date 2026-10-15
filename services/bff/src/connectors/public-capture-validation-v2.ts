import { z } from 'zod';
import { publicControlPayloadV2Schema } from '@axiom/types';
import { parseCatalogueJson } from '@axiom/control-library';
import { encodePublicEvidencePayloadV2 } from './public-evidence-codec-v2.js';
import { parsePublicUrl, type checkPublicWebsiteEvidenceV2 } from './public-website.js';

const sources = z
  .array(
    z
      .object({
        page: z.enum(['root', 'privacy', 'contact', 'terms', 'consent']),
        state: z.enum(['examined', 'unavailable', 'unexamined']),
        requestedUrl: z.string().max(2048).nullable(),
        finalUrl: z.string().max(2048).nullable(),
        contentSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict(),
  )
  .length(5);

/** Validate the collector-to-storage boundary before the single atomic RPC. */
export function validateFreshPublicCapture(
  value: Awaited<ReturnType<typeof checkPublicWebsiteEvidenceV2>>,
): boolean {
  try {
    const evidence = value.evidence;
    const payload = parseCatalogueJson(evidence.payloadText, 524288);
    const encoded = encodePublicEvidencePayloadV2(payload);
    if (
      encoded.codec !== evidence.codec ||
      encoded.payloadText !== evidence.payloadText ||
      encoded.payloadSha256 !== evidence.payloadSha256
    )
      return false;
    const provenance = sources.parse(evidence.pageSources);
    const admitted = publicControlPayloadV2Schema.parse(payload);
    if (admitted.pages.length !== 5 || new Set(provenance.map((p) => p.page)).size !== 5)
      return false;
    const origin = parsePublicUrl(value.check.finalUrl).origin;
    for (const p of admitted.pages) {
      const source = provenance.find((s) => s.page === p.page);
      if (
        !source ||
        source.state !== p.state ||
        (source.contentSha256 ?? undefined) !== p.contentSha256
      )
        return false;
      if (p.state === 'unexamined') {
        if (
          source.requestedUrl !== null ||
          source.finalUrl !== null ||
          source.contentSha256 !== null
        )
          return false;
      } else {
        if (!source.requestedUrl) return false;
        const requested = parsePublicUrl(source.requestedUrl);
        if (p.page !== 'root' && requested.origin !== origin) return false;
        if (p.state === 'examined') {
          if (!source.finalUrl) return false;
          const final = parsePublicUrl(source.finalUrl);
          if (p.page !== 'root' && final.origin !== origin) return false;
        } else if (source.finalUrl !== null || source.contentSha256 !== null) return false;
      }
      if (
        p.page === 'root' &&
        (p.state !== 'examined' ||
          p.contentSha256 !== value.check.contentSha256 ||
          source.requestedUrl !== value.check.requestedUrl ||
          source.finalUrl !== value.check.finalUrl)
      )
        return false;
    }
    for (const p of value.check.auditPages) {
      const source = provenance.find((s) => s.page === p.kind);
      if (
        !source ||
        source.requestedUrl !== p.requestedUrl ||
        source.finalUrl !== (p.finalUrl ?? null) ||
        source.state !== (p.status === 'checked' ? 'examined' : 'unavailable') ||
        source.contentSha256 !== (p.contentSha256 ?? null)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
