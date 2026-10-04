import { parse, type DefaultTreeAdapterMap } from 'parse5';
import {
  PUBLIC_FORM_MAX_FORMS as MAX_FORMS,
  PUBLIC_FORM_MAX_CONTROLS as MAX_CONTROLS,
  PUBLIC_FORM_INPUT_TYPES as inputTypes,
  type PublicFormMetadata,
} from '@axiom/types';

export { publicFormMetadataSchema, type PublicFormMetadata } from '@axiom/types';

const excludedInputTypes = new Set([
  'hidden',
  'password',
  'file',
  'submit',
  'image',
  'reset',
  'button',
]);
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
