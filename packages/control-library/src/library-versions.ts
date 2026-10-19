/**
 * Explicit control-library version resolution.
 *
 * Every consumer that verifies or renders a retained artifact must resolve the
 * library by the version recorded in that artifact, never "the latest". An
 * unknown version is refused, never substituted.
 *
 * DEFAULT_LIBRARY_VERSION is the version NEW assessments use. It stays 0.1.1:
 * startup never changes it. Explicit operator publication and recorded founder
 * approval are required before 0.2.0 can be used. Runtime dispatch resolves the
 * version retained by the assessment and the immutable database approval registry.
 */
import type { Control } from './types';
import {
  controls as controls_0_1_1,
  LIBRARY_BASELINE,
  LIBRARY_CHANGELOG,
  LIBRARY_DEFAULT_EFFECTIVE_FROM,
  LIBRARY_PUBLISHED_AT,
  LIBRARY_PUBLISHER,
  LIBRARY_VERSION,
} from './controls';
import { controlSeedRow } from './seed';
import {
  controls_0_2_0,
  LIBRARY_BASELINE_0_2_0,
  LIBRARY_CHANGELOG_0_2_0,
  LIBRARY_DEFAULT_EFFECTIVE_FROM_0_2_0,
  LIBRARY_PUBLISHED_AT_0_2_0,
  LIBRARY_PUBLISHER_0_2_0,
  LIBRARY_VERSION_0_2_0,
} from './versions/v0_2_0/controls';
import {
  citationCommencement,
  CORRECTED_CONTROL_RECORDS_0_2_0,
  type CommencementGroup,
  type ControlLegalRecord,
} from './versions/v0_2_0/legal-registry';

export type LibraryVersionStatus = 'published' | 'candidate';

export interface ControlCommencement {
  controlId: string;
  /** Latest commencement among the cited DPDP provisions, or null if none. */
  effectiveFrom: string | null;
  provisions: {
    instrument: string;
    reference: string;
    group: CommencementGroup | null;
    commencesOn: string | null;
  }[];
}

export interface ResolvedControlLibrary {
  version: string;
  status: LibraryVersionStatus;
  publishedAt: string;
  publishedBy: string;
  changeLog: string;
  baseline: string;
  defaultEffectiveFrom: string;
  controls: readonly Control[];
  /** Per-control phased commencement. Absent for 0.1.1, whose source did not carry it. */
  commencement: readonly ControlCommencement[] | null;
  /** Legal classification records for controls corrected in this version. */
  legalRecords: readonly ControlLegalRecord[];
}

export class UnknownLibraryVersionError extends Error {
  constructor(readonly version: string) {
    super(`Unknown control library version refused: ${JSON.stringify(version).slice(0, 80)}`);
    this.name = 'UnknownLibraryVersionError';
  }
}

export const DEFAULT_LIBRARY_VERSION = LIBRARY_VERSION;

/** Derive phased commencement for each control from its own citations. */
export function deriveCommencement(list: readonly Control[]): ControlCommencement[] {
  return list.map((c) => {
    const provisions = c.citations.flatMap((cit) =>
      citationCommencement(cit.instrument, cit.reference),
    );
    const dates = provisions.map((p) => p.commencesOn).filter((d): d is string => d !== null);
    return {
      controlId: c.id,
      effectiveFrom: dates.length ? [...dates].sort().at(-1)! : null,
      provisions,
    };
  });
}

const REGISTRY: ReadonlyMap<string, () => ResolvedControlLibrary> = new Map<
  string,
  () => ResolvedControlLibrary
>([
  [
    LIBRARY_VERSION,
    () => ({
      version: LIBRARY_VERSION,
      status: 'published',
      publishedAt: LIBRARY_PUBLISHED_AT,
      publishedBy: LIBRARY_PUBLISHER,
      changeLog: LIBRARY_CHANGELOG,
      baseline: LIBRARY_BASELINE,
      defaultEffectiveFrom: LIBRARY_DEFAULT_EFFECTIVE_FROM,
      controls: controls_0_1_1,
      commencement: null,
      legalRecords: [],
    }),
  ],
  [
    LIBRARY_VERSION_0_2_0,
    () => ({
      version: LIBRARY_VERSION_0_2_0,
      status: 'candidate',
      publishedAt: LIBRARY_PUBLISHED_AT_0_2_0,
      publishedBy: LIBRARY_PUBLISHER_0_2_0,
      changeLog: LIBRARY_CHANGELOG_0_2_0,
      baseline: LIBRARY_BASELINE_0_2_0,
      defaultEffectiveFrom: LIBRARY_DEFAULT_EFFECTIVE_FROM_0_2_0,
      controls: controls_0_2_0,
      commencement: deriveCommencement(controls_0_2_0),
      legalRecords: CORRECTED_CONTROL_RECORDS_0_2_0,
    }),
  ],
]);

/** Versions this package can resolve, oldest first. 0.1.0 source is not retained here. */
export const KNOWN_LIBRARY_VERSIONS: readonly string[] = Object.freeze([...REGISTRY.keys()]);

export function resolveControlLibrary(version: string): ResolvedControlLibrary {
  const entry = typeof version === 'string' ? REGISTRY.get(version) : undefined;
  if (!entry) throw new UnknownLibraryVersionError(String(version));
  return entry();
}

/** Seed payload for an explicit version. For 0.1.1 this equals `buildLibrarySeed()`. */
export function buildLibrarySeedForVersion(version: string) {
  const lib = resolveControlLibrary(version);
  return {
    version: lib.version,
    publishedAt: lib.publishedAt,
    publishedBy: lib.publishedBy,
    changeLog: lib.changeLog,
    controls: lib.controls.map((c) => controlSeedRow(c, lib.version)),
  };
}

export type CommencementStatus =
  | 'in_force'
  | 'partially_in_force'
  | 'not_yet_in_force'
  | 'outside_dpdp_commencement'
  | 'unknown_for_version';

/**
 * Commencement status of a control on an assessment date (YYYY-MM-DD). A
 * not-yet-commenced control is readiness against a published future duty, not
 * a finding of an enforceable breach.
 */
export function commencementStatusAsOf(
  version: string,
  controlId: string,
  asOf: string,
): CommencementStatus {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('commencement_as_of_refused');
  const lib = resolveControlLibrary(version);
  if (!lib.commencement) return 'unknown_for_version';
  const record = lib.commencement.find((c) => c.controlId === controlId);
  if (!record) throw new Error('commencement_control_refused');
  const dated = record.provisions.filter((p) => p.commencesOn !== null);
  if (!dated.length) return 'outside_dpdp_commencement';
  const commenced = dated.filter((p) => p.commencesOn! <= asOf).length;
  if (commenced === dated.length) return 'in_force';
  return commenced === 0 ? 'not_yet_in_force' : 'partially_in_force';
}
