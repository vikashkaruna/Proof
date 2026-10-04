import { describe, expect, it } from 'vitest';
import { extractPublicFormMetadata, publicFormMetadataSchema } from './public-form-metadata.js';

const digest = 'a'.repeat(64);
const extract = (html: string) => extractPublicFormMetadata(html, digest);

describe('public static form metadata', () => {
  it('retains only observed structural attributes, with no values, labels, identifiers or action', () => {
    const metadata =
      extract(`<form id="private-form-id" action="http://169.254.169.254/submit?token=private" method="POST">
      <label for="private-id">Private label Alice</label>
      <input id="private-id" name="private-field-name" type="EMAIL" required="off" value="alice-private@public.org">
      <textarea placeholder="private-placeholder">private-message</textarea>
      <select><option value="private-option" selected>Private option text</option></select>
      <input type="password" value="private-password"><input type="hidden" value="private-csrf">
      <input type="file" name="private-upload"><button>Private button</button>
      <input type="text" form="another-private-form" value="private-associated-value">
    </form>`);
    expect(metadata).toEqual({
      version: 1,
      scope: 'static_html_form_descendants',
      sourceSha256: digest,
      observedFormCount: 1,
      formsTruncated: false,
      forms: [
        {
          ordinal: 1,
          method: 'post',
          observedControlCount: 8,
          excludedControlCount: 5,
          controlsTruncated: false,
          controls: [
            {
              ordinal: 1,
              element: 'input',
              inputType: 'email',
              requiredAttribute: true,
              disabledAttribute: false,
            },
            { ordinal: 2, element: 'textarea', requiredAttribute: false, disabledAttribute: false },
            { ordinal: 3, element: 'select', requiredAttribute: false, disabledAttribute: false },
          ],
        },
      ],
    });
    expect(publicFormMetadataSchema.safeParse(metadata).success).toBe(true);
    const serialized = JSON.stringify(metadata);
    for (const raw of ['private', 'Alice', '169.254.169.254', 'submit?', 'placeholder', 'label'])
      expect(serialized).not.toContain(raw);
  });

  it('reports sensitive-only forms as observed with excluded controls, not as missing', () => {
    const metadata = extract(
      '<form><input type=HIDDEN><input type=PASSWORD><input type=file></form>',
    );
    expect(metadata.observedFormCount).toBe(1);
    expect(metadata.forms[0]).toMatchObject({
      observedControlCount: 3,
      excludedControlCount: 3,
      controls: [],
      controlsTruncated: false,
    });
    expect(extract('<p>No static form here</p>')).toMatchObject({
      observedFormCount: 0,
      forms: [],
      formsTruncated: false,
    });
  });

  it('uses HTML semantics, excluding inert markup and treating data-attribute lookalikes honestly', () => {
    const metadata = extract(`<!-- <form><input></form> -->
      <script>const fake = '<form><input></form>';</script>
      <style>content: '<form><input></form>';</style>
      <noscript><form><input></form></noscript>
      <template><form><input></form></template>
      <form method="unexpected"><input data-type="hidden" data-required="yes" disabled>
      <input type="unknown" required><input type="email" value="x > <form><input>"></form>`);
    expect(metadata.observedFormCount).toBe(1);
    expect(metadata.forms[0]).toMatchObject({
      method: 'get',
      observedControlCount: 3,
      excludedControlCount: 0,
      controls: [
        { inputType: 'text', requiredAttribute: false, disabledAttribute: true },
        { inputType: 'text', requiredAttribute: true, disabledAttribute: false },
        { inputType: 'email', requiredAttribute: false, disabledAttribute: false },
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain('unknown');
    expect(JSON.stringify(metadata)).not.toContain('value');
  });

  it('records declared attributes without asserting effective visibility, consent or submission', () => {
    const metadata = extract(`<form method="dialog"><fieldset disabled>
      <input type=checkbox checked value="private-consent-choice">
      <input type=radio style="display:none" required>
    </fieldset><select disabled multiple><option selected>private-selected-option</option></select></form>`);
    expect(metadata.forms[0]).toMatchObject({
      method: 'dialog',
      controls: [
        {
          element: 'input',
          inputType: 'checkbox',
          requiredAttribute: false,
          disabledAttribute: false,
        },
        { element: 'input', inputType: 'radio', requiredAttribute: true, disabledAttribute: false },
        { element: 'select', requiredAttribute: false, disabledAttribute: true },
      ],
    });
    const serialized = JSON.stringify(metadata);
    for (const unverified of ['private', 'checked', 'selected', 'visible', 'consent', 'processing'])
      expect(serialized).not.toContain(unverified);
  });

  it('bounds retained forms and controls while preserving exact observed/excluded counts', () => {
    const metadata = extract(
      Array.from(
        { length: 5 },
        () => `<form>${'<input type=email>'.repeat(14)}<input type=hidden></form>`,
      ).join(''),
    );
    expect(metadata.observedFormCount).toBe(5);
    expect(metadata.formsTruncated).toBe(true);
    expect(metadata.forms).toHaveLength(3);
    expect(metadata.forms.map((form) => form.ordinal)).toEqual([1, 2, 3]);
    for (const form of metadata.forms) {
      expect(form.observedControlCount).toBe(15);
      expect(form.excludedControlCount).toBe(1);
      expect(form.controlsTruncated).toBe(true);
      expect(form.controls).toHaveLength(12);
      expect(form.controls.map((control) => control.ordinal)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
    }
    expect(publicFormMetadataSchema.safeParse(metadata).success).toBe(true);
  });

  it('traverses deeply nested bounded HTML without recursion or fabricating detached controls', () => {
    const metadata = extract(
      `<input type=email><form>${'<div>'.repeat(6000)}<input type=tel>${'</div>'.repeat(6000)}</form>`,
    );
    expect(metadata.forms[0]?.controls).toEqual([
      {
        ordinal: 1,
        element: 'input',
        inputType: 'tel',
        requiredAttribute: false,
        disabledAttribute: false,
      },
    ]);
  });

  it.each([
    (metadata: ReturnType<typeof extract>) => ({ ...metadata, version: 2 }),
    (metadata: ReturnType<typeof extract>) => ({ ...metadata, sourceSha256: 'invalid' }),
    (metadata: ReturnType<typeof extract>) => ({ ...metadata, inferredRegion: 'ap-south-1' }),
    (metadata: ReturnType<typeof extract>) => ({ ...metadata, observedFormCount: 2 }),
    (metadata: ReturnType<typeof extract>) => ({ ...metadata, formsTruncated: true }),
    (metadata: ReturnType<typeof extract>) => ({
      ...metadata,
      forms: [{ ...metadata.forms[0], observedControlCount: 0 }],
    }),
    (metadata: ReturnType<typeof extract>) => ({
      ...metadata,
      forms: [{ ...metadata.forms[0], controlsTruncated: true }],
    }),
    (metadata: ReturnType<typeof extract>) => ({
      ...metadata,
      forms: [
        {
          ...metadata.forms[0],
          controls: [{ ...metadata.forms[0]?.controls[0], value: 'secret' }],
        },
      ],
    }),
  ])('refuses malformed or unsupported metadata %#', (mutate) => {
    expect(
      publicFormMetadataSchema.safeParse(mutate(extract('<form><input type=email></form>')))
        .success,
    ).toBe(false);
  });
});
