import { z } from 'zod';

/** Pinned actual Python 3.14 renderer_commitment() bytes. Updating the renderer
 * requires an explicitly reviewed manifest version/commitment and replay of the
 * shared contract; callers cannot choose a configuration by supplying a digest.
 */
export const PRATIVEDAN_RENDERER_CONFIG_VERSION = 'prativedan-draft-v1';
export const PRATIVEDAN_RENDERER_AGENT_VERSION = '0.1.0';
export const PRATIVEDAN_RENDERER_CONFIG_SHA256 =
  'b6b22a3360126539085f1630cdb390396fc97ca72fc894259c7c4cb7bc3d0ba3';
export const PRATIVEDAN_RENDERER_CONFIG_TEXT =
  '{"agent":"prativedan","agent_version":"0.1.0","citation_policy":"explicit-canonical-nonzero-uuid-references-unverified","citation_verification":"unverified_references","exposure_divisor":10000000,"exposure_format":".2f","finding_limit":10,"finding_order":"numeric-finite-nonnegative-risk-desc-otherwise-source-order","html_escape":"python-html-escape-quote-true","html_findings_columns":["control_id","title","severity","score","risk_points"],"implementation":"deterministic-prativedan-sections-html-v1","model_identity":null,"model_inference":false,"posture_bands":[[85,"Strong"],[65,"Acceptable"],[40,"At Risk"],[0,"Critical"]],"posture_format":".0f","ranked_findings_title":"Top findings (by risk-weighted exposure)","renderer_config_version":"prativedan-draft-v1","review_required":true,"schema_version":1,"section_order":["executive_summary","findings_table","library","attribution"],"source_findings_title":"Findings for review (source order)","source_rationale_suffix":" [Draft assessment declaration: answer={answer_state}; applicability={applicability_state}; evidence unverified.]"}';

export const prativedanRendererConfigSchema = z
  .object({
    schema_version: z.literal(1),
    renderer_config_version: z.literal(PRATIVEDAN_RENDERER_CONFIG_VERSION),
    agent: z.literal('prativedan'),
    agent_version: z.literal(PRATIVEDAN_RENDERER_AGENT_VERSION),
    implementation: z.literal('deterministic-prativedan-sections-html-v1'),
    model_inference: z.literal(false),
    model_identity: z.null(),
    section_order: z.tuple([
      z.literal('executive_summary'),
      z.literal('findings_table'),
      z.literal('library'),
      z.literal('attribution'),
    ]),
    finding_limit: z.literal(10),
    finding_order: z.literal('numeric-finite-nonnegative-risk-desc-otherwise-source-order'),
    ranked_findings_title: z.literal('Top findings (by risk-weighted exposure)'),
    source_findings_title: z.literal('Findings for review (source order)'),
    posture_bands: z.tuple([
      z.tuple([z.literal(85), z.literal('Strong')]),
      z.tuple([z.literal(65), z.literal('Acceptable')]),
      z.tuple([z.literal(40), z.literal('At Risk')]),
      z.tuple([z.literal(0), z.literal('Critical')]),
    ]),
    posture_format: z.literal('.0f'),
    exposure_divisor: z.literal(10000000),
    exposure_format: z.literal('.2f'),
    html_escape: z.literal('python-html-escape-quote-true'),
    html_findings_columns: z.tuple([
      z.literal('control_id'),
      z.literal('title'),
      z.literal('severity'),
      z.literal('score'),
      z.literal('risk_points'),
    ]),
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
    citation_policy: z.literal('explicit-canonical-nonzero-uuid-references-unverified'),
    source_rationale_suffix: z.literal(
      ' [Draft assessment declaration: answer={answer_state}; applicability={applicability_state}; evidence unverified.]',
    ),
  })
  .strict();
export type PrativedanRendererConfig = z.infer<typeof prativedanRendererConfigSchema>;
