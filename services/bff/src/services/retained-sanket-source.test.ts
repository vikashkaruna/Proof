import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  readRetainedSanketCapture,
  retainedSanketCaptureSchema,
  retainedSanketInput,
  recoverRetainedSanketOutput,
  validateRetainedSanketOutput,
  startRetainedSanketDispatch,
} from './retained-sanket-source.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
// Synthetic RPC consistency fixtures only. No source/authority or HTTP grant.
async function fixture() {
  const raw = {
    requestedUrl: 'https://axiomminds.ai/',
    finalUrl: 'https://axiomminds.ai/',
    checkedAt: '2026-10-08T07:41:58.139Z',
    status: 'checked',
    httpStatus: 200,
    bytes: 170,
    contentSha256: 'a'.repeat(64),
    title: 'Synthetic Public RFP',
    headings: ['Public services'],
    publicLinks: [],
  };
  const text = JSON.stringify(raw);
  const source = {
    check_id: id(6),
    capture_actor_id: id(7),
    capture_correlation_id: id(8),
    capture_receipt: '10',
    result_sha256: await sha256(text),
    requested_url: raw.requestedUrl,
    final_url: raw.finalUrl,
    checked_at: raw.checkedAt,
    content_sha256: raw.contentSha256,
    byte_size: raw.bytes,
    title: raw.title,
    headings: raw.headings,
  };
  const preview = {
    source,
    source_hash: await sha256(canonicalJson(source)),
    capture_result_text: text,
  };
  const input = retainedSanketInput(id(1), id(3), id(5), source);
  const projection = {
    requested_url: source.requested_url,
    final_url: source.final_url,
    checked_at: source.checked_at,
    content_sha256: source.content_sha256,
    byte_size: source.byte_size,
    title: source.title,
    headings: source.headings,
    capture_reference: source.check_id,
  };
  const output = {
    signals: [
      {
        source: source.check_id,
        company: 'axiomminds.ai',
        signal: 'public_rfp_heading',
        detected_at: source.checked_at,
        score: 0,
        url: source.final_url,
        context:
          'Marker observed in a bounded public title/heading. The host is a source identifier, not a verified legal company identity. Hiring, procurement, applicability, recency and buying intent are unverified; human review is required.',
      },
    ],
    high_intent: [],
    source_observations: [
      {
        requested_url: source.requested_url,
        final_url: source.final_url,
        checked_at: source.checked_at,
        content_sha256: source.content_sha256,
        projection_sha256: await sha256(canonicalJson(projection)),
        capture_reference: source.check_id,
        observed_notice_kinds: ['public_rfp_heading'],
        requires_human_review: true,
      },
    ],
    processing_mode: 'verified_public_capture_review',
    notes:
      'Processed only supplied approved public captures and explicit title/heading markers. Zero score and empty high-intent list preserve unknown buying intent. Capture time is not notice publication time. Sector/geography preferences do not establish source-company classification. No contact records, outreach, login or message delivery is performed.',
  };
  const row = {
    run_id: id(4),
    input_hash: await sha256(canonicalJson(input)),
    output_hash: await sha256(canonicalJson(output)),
    output_text: canonicalJson(output),
    requested_receipt: '20',
    started_receipt: '21',
    completed_receipt: '22',
    settled_receipt: '23',
  };
  return { preview, input, output, row };
}
function writer(data: unknown, error: unknown = null) {
  const abort = vi.fn(async (_signal: AbortSignal) => ({ data, error }));
  const rpc = vi.fn((_name: string, _args: Record<string, unknown>) => ({ abortSignal: abort }));
  return { factory: () => ({ rpc }), rpc, abort };
}
describe('retained Sanket RPC consistency boundary', () => {
  it('records the exact server-loaded source through the human RPC without invoking runtime', async () => {
    const f = await fixture(),
      w = writer({ run_id: id(4), created: true, status: 'running' });
    const loaded = {
      capture: f.preview.source,
      captureResultText: f.preview.capture_result_text,
      sourceHash: f.preview.source_hash,
    };
    expect(await startRetainedSanketDispatch(id(1), id(2), f.input, loaded, w.factory)).toEqual({
      run_id: id(4),
      created: true,
      status: 'running',
    });
    expect(w.rpc).toHaveBeenCalledExactlyOnceWith('start_retained_sanket_dispatch', {
      p_tenant_id: id(1),
      p_actor_id: id(2),
      p_engagement_id: id(3),
      p_operation_key: id(5),
      p_input_text: canonicalJson(f.input),
      p_capture_result_text: f.preview.capture_result_text,
    });
  });
  it.each(['witness', 'source', 'tenant'])(
    'refuses changed start binding %s before human mutation',
    async (field) => {
      const f = await fixture(),
        w = writer({ run_id: id(4), created: true, status: 'running' });
      const loaded = {
        capture: structuredClone(f.preview.source),
        captureResultText: f.preview.capture_result_text,
        sourceHash: f.preview.source_hash,
      };
      if (field === 'witness') loaded.captureResultText += ' ';
      if (field === 'source') loaded.capture.title = 'Invented notice';
      await expect(
        startRetainedSanketDispatch(
          field === 'tenant' ? id(99) : id(1),
          id(2),
          f.input,
          loaded,
          w.factory,
        ),
      ).rejects.toThrow('sanket_source_conflict');
      expect(w.rpc).not.toHaveBeenCalled();
    },
  );
  it('preserves an existing recorded request acknowledgement without implying another invocation', async () => {
    const f = await fixture();
    const loaded = {
      capture: f.preview.source,
      captureResultText: f.preview.capture_result_text,
      sourceHash: f.preview.source_hash,
    };
    const w = writer({ run_id: id(4), created: false, status: 'running' });
    expect(
      (await startRetainedSanketDispatch(id(1), id(2), f.input, loaded, w.factory)).created,
    ).toBe(false);
    expect(w.rpc).toHaveBeenCalledTimes(1);
  });
  it('refuses a created acknowledgement claiming work already succeeded', async () => {
    const f = await fixture();
    await expect(
      startRetainedSanketDispatch(
        id(1),
        id(2),
        f.input,
        {
          capture: f.preview.source,
          captureResultText: f.preview.capture_result_text,
          sourceHash: f.preview.source_hash,
        },
        writer({ run_id: id(4), created: true, status: 'succeeded' }).factory,
      ),
    ).rejects.toThrow('sanket_source_conflict');
  });
  it('loads source only through restricted SQL and retains exact opaque result bytes', async () => {
    const f = await fixture(),
      w = writer(f.preview);
    const loaded = await readRetainedSanketCapture(id(1), id(2), id(3), id(6), w.factory);
    expect(loaded.captureResultText).toBe(f.preview.capture_result_text);
    expect(w.rpc).toHaveBeenCalledExactlyOnceWith('preview_retained_sanket_source', {
      p_tenant_id: id(1),
      p_actor_id: id(2),
      p_engagement_id: id(3),
      p_check_id: id(6),
    });
    expect(w.abort.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(loaded.capture.headings)).toBe(true);
  });
  it.each(['9223372036854775808', '9999999999999999999'])(
    'refuses capture receipt overflow %s',
    async (receipt) => {
      const f = await fixture();
      expect(
        retainedSanketCaptureSchema.safeParse({ ...f.preview.source, capture_receipt: receipt })
          .success,
      ).toBe(false);
    },
  );
  it.each(['', '0', '01', '+1', '1 ', '1\n', '1.0', 'abc'])(
    'refuses noncanonical receipt without throwing %s',
    async (receipt) => {
      const f = await fixture();
      expect(
        retainedSanketCaptureSchema.safeParse({ ...f.preview.source, capture_receipt: receipt })
          .success,
      ).toBe(false);
    },
  );
  it('accepts exact signed int64 maximum', async () => {
    const f = await fixture();
    expect(
      retainedSanketCaptureSchema.parse({
        ...f.preview.source,
        capture_receipt: '9223372036854775807',
      }).capture_receipt,
    ).toBe('9223372036854775807');
  });
  it.each(['source_hash', 'result_sha256', 'check_id', 'title', 'headings'])(
    'refuses changed SQL source %s',
    async (key) => {
      const f = await fixture();
      if (key === 'source_hash') f.preview.source_hash = 'b'.repeat(64);
      else if (key === 'result_sha256') f.preview.source.result_sha256 = 'b'.repeat(64);
      else if (key === 'check_id') f.preview.source.check_id = id(99);
      else if (key === 'title') f.preview.source.title = 'Invented hiring';
      else f.preview.source.headings = ['Invented DPO'];
      if (key === 'title' || key === 'headings')
        f.preview.source_hash = await sha256(canonicalJson(f.preview.source));
      await expect(
        readRetainedSanketCapture(id(1), id(2), id(3), id(6), writer(f.preview).factory),
      ).rejects.toThrow('sanket_source_conflict');
    },
  );
  it('does not expose original RPC error or retry', async () => {
    const w = writer(null, { message: 'private database diagnostic' });
    await expect(readRetainedSanketCapture(id(1), id(2), id(3), id(6), w.factory)).rejects.toThrow(
      'sanket_output_uncertain',
    );
    expect(w.rpc).toHaveBeenCalledTimes(1);
  });
  it('binds original PG witness bytes rather than a JSON reserialization', async () => {
    const f = await fixture();
    f.preview.capture_result_text += ' ';
    await expect(
      readRetainedSanketCapture(id(1), id(2), id(3), id(6), writer(f.preview).factory),
    ).rejects.toThrow('sanket_source_conflict');
  });
  it('refuses a server result witness over the UTF8 byte budget', async () => {
    const f = await fixture();
    f.preview.capture_result_text = 'ह'.repeat(12000);
    await expect(
      readRetainedSanketCapture(id(1), id(2), id(3), id(6), writer(f.preview).factory),
    ).rejects.toThrow('sanket_source_conflict');
  });
  it('recovers exact canonical output and ordered receipts without dispatching', async () => {
    const f = await fixture(),
      w = writer(f.row);
    const result = await recoverRetainedSanketOutput(id(1), id(2), f.input, w.factory);
    expect(result?.data.high_intent).toEqual([]);
    expect(result?.outputProof.settledReceipt).toBe('23');
    expect(w.rpc).toHaveBeenCalledExactlyOnceWith('recover_retained_sanket_output', {
      p_tenant_id: id(1),
      p_actor_id: id(2),
      p_engagement_id: id(3),
      p_operation_key: id(5),
      p_input_text: canonicalJson(f.input),
    });
  });
  it.each(['requested_receipt', 'started_receipt', 'completed_receipt', 'settled_receipt'])(
    'rejects overflow in recovered %s',
    async (field) => {
      const f = await fixture();
      await expect(
        recoverRetainedSanketOutput(
          id(1),
          id(2),
          f.input,
          writer({ ...f.row, [field]: '9223372036854775808' }).factory,
        ),
      ).rejects.toThrow('sanket_source_conflict');
    },
  );
  it.each(['input_hash', 'output_hash', 'output_text', 'requested_receipt', 'completed_receipt'])(
    'rejects altered settled binding %s',
    async (field) => {
      const f = await fixture();
      const bad = field.endsWith('hash')
        ? 'b'.repeat(64)
        : field === 'output_text'
          ? f.row.output_text + ' '
          : '10';
      await expect(
        recoverRetainedSanketOutput(
          id(1),
          id(2),
          f.input,
          writer({ ...f.row, [field]: bad }).factory,
        ),
      ).rejects.toThrow('sanket_source_conflict');
    },
  );
  it('refuses another tenant before any RPC', async () => {
    const f = await fixture(),
      w = writer(f.row);
    await expect(recoverRetainedSanketOutput(id(99), id(2), f.input, w.factory)).rejects.toThrow(
      'sanket_source_conflict',
    );
    expect(w.rpc).not.toHaveBeenCalled();
  });
  it('distinguishes missing from an uncertain legacy run and never reconstructs output', async () => {
    const f = await fixture();
    expect(
      await recoverRetainedSanketOutput(id(1), id(2), f.input, writer({ missing: true }).factory),
    ).toBeNull();
    await expect(
      recoverRetainedSanketOutput(
        id(1),
        id(2),
        f.input,
        writer({ error: 'output_unrecoverable' }).factory,
      ),
    ).rejects.toThrow('sanket_output_uncertain');
    await expect(
      recoverRetainedSanketOutput(
        id(1),
        id(2),
        f.input,
        writer({ missing: true, output_text: f.row.output_text }).factory,
      ),
    ).rejects.toThrow('sanket_source_conflict');
  });
  it.each(['score', 'high_intent', 'capture_reference', 'projection_sha256', 'company', 'extra'])(
    'rejects unsupported output %s',
    async (field) => {
      const f = await fixture();
      const raw = structuredClone(f.output);
      if (field === 'score') raw.signals[0]!.score = 80;
      else if (field === 'high_intent') Object.assign(raw, { high_intent: raw.signals });
      else if (field === 'capture_reference')
        raw.source_observations[0]!.capture_reference = id(99);
      else if (field === 'projection_sha256')
        raw.source_observations[0]!.projection_sha256 = 'b'.repeat(64);
      else if (field === 'company') raw.signals[0]!.company = 'Verified legal entity';
      else Object.assign(raw, { release: true });
      await expect(validateRetainedSanketOutput(f.input, raw)).rejects.toThrow(
        'sanket_source_conflict',
      );
    },
  );
});
