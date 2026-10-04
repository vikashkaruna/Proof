import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';

const MAX_FORMS = 3;
const MAX_CONTROLS = 12;
// The checker accepts at most 512KiB of HTML; no count can exceed its byte bound.
const MAX_COUNT = 512 * 1024;
const inputTypes = [
  'text',
  'email',
  'tel',
  'url',
  'search',
  'number',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
  'color',
  'range',
  'checkbox',
  'radio',
] as const;
const excludedInputTypes = new Set([
  'hidden',
  'password',
  'file',
  'submit',
  'image',
  'reset',
  'button',
]);
const count = z.number().int().min(0).max(MAX_COUNT);
const controlSchema = z
  .object({
    ordinal: z.number().int().min(1).max(MAX_COUNT),
    element: z.enum(['input', 'select', 'textarea']),
    inputType: z.enum(inputTypes).optional(),
    requiredAttribute: z.boolean(),
    disabledAttribute: z.boolean(),
  })
  .strict()
  .refine((control) => (control.element === 'input') === (control.inputType !== undefined));
const formSchema = z
  .object({
    ordinal: z.number().int().min(1).max(MAX_FORMS),
    method: z.enum(['get', 'post', 'dialog']),
    observedControlCount: count,
    excludedControlCount: count,
    controlsTruncated: z.boolean(),
    controls: z.array(controlSchema).max(MAX_CONTROLS),
  })
  .strict()
  .refine((form) => {
    const eligible = form.observedControlCount - form.excludedControlCount;
    return (
      eligible >= 0 &&
      form.controls.length === Math.min(eligible, MAX_CONTROLS) &&
      form.controlsTruncated === eligible > MAX_CONTROLS &&
      form.controls.every(
        (control, i) =>
          control.ordinal <= form.observedControlCount &&
          (i === 0 || control.ordinal > form.controls[i - 1]!.ordinal),
      )
    );
  });

/** Only source-bound static attributes; never values, labels, identifiers or submission targets. */
export const publicFormMetadataSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal('static_html_form_descendants'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedFormCount: count,
    formsTruncated: z.boolean(),
    forms: z.array(formSchema).max(MAX_FORMS),
  })
  .strict()
  .refine(
    (metadata) =>
      metadata.forms.length === Math.min(metadata.observedFormCount, MAX_FORMS) &&
      metadata.formsTruncated === metadata.observedFormCount > MAX_FORMS &&
      metadata.forms.every((form, index) => form.ordinal === index + 1),
  );
export type PublicFormMetadata = z.infer<typeof publicFormMetadataSchema>;
type Node = DefaultTreeAdapterMap['node'];
export type PublicHtmlDocument = DefaultTreeAdapterMap['document'];
export const parsePublicHtml = (html: string): PublicHtmlDocument => parse(html);
type Element = DefaultTreeAdapterMap['element'];
const inert = new Set(['script', 'style', 'noscript', 'template']);
const formControls = new Set([
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'option',
  'datalist',
  'label',
]);

function isHtmlElement(node: Node): node is Element {
  return 'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml';
}
function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}
function* nodes(root: Node, excludeFormControls = false): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (
      isHtmlElement(node) &&
      (inert.has(node.tagName) || (excludeFormControls && formControls.has(node.tagName)))
    )
      continue;
    yield node;
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
    }
  }
}
export function* publicHtmlElements(root: Node, excludeFormControls = false): Generator<Element> {
  for (const node of nodes(root, excludeFormControls)) if (isHtmlElement(node)) yield node;
}
/** Entity decoding comes from the HTML parser, never from attribute values or control text. */
export function publicHtmlText(root: Node): string {
  const text: string[] = [];
  for (const node of nodes(root, true)) {
    if (node.nodeName === '#text' && 'value' in node) text.push(node.value);
  }
  return text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** HTML is parsed without scripts, network access or interaction; the caller enforces body limits. */
export function extractPublicFormMetadata(
  html: string | PublicHtmlDocument,
  sourceSha256: string,
): PublicFormMetadata {
  const forms: PublicFormMetadata['forms'] = [];
  let observedFormCount = 0;
  for (const form of publicHtmlElements(typeof html === 'string' ? parsePublicHtml(html) : html)) {
    if (form.tagName !== 'form') continue;
    observedFormCount++;
    if (forms.length >= MAX_FORMS) continue;
    const controls: PublicFormMetadata['forms'][number]['controls'] = [];
    let observedControlCount = 0;
    let excludedControlCount = 0;
    for (const control of publicHtmlElements(form)) {
      if (!['input', 'select', 'textarea', 'button'].includes(control.tagName)) continue;
      observedControlCount++;
      const declaredType = (attribute(control, 'type') ?? 'text').toLowerCase();
      // Explicit form ownership needs a separate adapter. Excluded controls
      // remain counted, so credentials/hidden controls are never reported absent.
      if (
        control.tagName === 'button' ||
        attribute(control, 'form') !== undefined ||
        (control.tagName === 'input' && excludedInputTypes.has(declaredType))
      ) {
        excludedControlCount++;
        continue;
      }
      if (controls.length >= MAX_CONTROLS) continue;
      const inputType = inputTypes.find((type) => type === declaredType) ?? 'text';
      controls.push({
        ordinal: observedControlCount,
        element: control.tagName as 'input' | 'select' | 'textarea',
        ...(control.tagName === 'input' ? { inputType } : {}),
        requiredAttribute: attribute(control, 'required') !== undefined,
        disabledAttribute: attribute(control, 'disabled') !== undefined,
      });
    }
    const declaredMethod = (attribute(form, 'method') ?? '').toLowerCase();
    forms.push({
      ordinal: observedFormCount,
      method: declaredMethod === 'post' || declaredMethod === 'dialog' ? declaredMethod : 'get',
      observedControlCount,
      excludedControlCount,
      controlsTruncated: observedControlCount - excludedControlCount > MAX_CONTROLS,
      controls,
    });
  }
  return {
    version: 1,
    scope: 'static_html_form_descendants',
    sourceSha256,
    observedFormCount,
    formsTruncated: observedFormCount > MAX_FORMS,
    forms,
  };
}
