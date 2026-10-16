import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  probeRegisteredResponse,
  registeredResponseScope,
  registeredResponseProbeSchema,
  type RegisteredResponseProbe,
} from './registered-response-probe.js';
const canary = 'private-token-https://private.invalid/?secret=canary';
const scope = {
  tenantMatches: true,
  actorMatches: true,
  bodyKindMatches: null,
  operationKeyMatches: null,
};
const response = (value: unknown) => ({
  json: async () => value,
  headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
});
test('same original parse succeeds without writing and returns identical object', async () => {
  const result = { data: { ok: true } };
  assert.equal(
    await probeRegisteredResponse(
      response(result),
      'target-submit',
      scope,
      (x) => x,
      () => assert.fail('success is not a failed probe'),
    ),
    result,
  );
});
test('JSON/transport errors retain finite class and same error identity, not message', async () => {
  for (const error of [new SyntaxError(canary), new TypeError(canary), new Error(canary), canary]) {
    let probe: RegisteredResponseProbe | undefined;
    await assert.rejects(
      probeRegisteredResponse(
        {
          json: async () => {
            throw error;
          },
          headers: () => ({ 'content-type': 'text/html; secret=' + canary }),
        },
        'saved-targets',
        scope,
        (x) => x,
        (p) => {
          probe = p;
        },
      ),
      (e) => e === error,
    );
    assert.equal(probe?.stage, 'response-json');
    assert.equal(probe?.mediaType, 'html');
    assert.equal(probe?.shape.topObject, false);
    assert(!JSON.stringify(probe).includes(canary));
  }
});
test('actual Zod errors emit only bounded allowlisted code/paths and envelope shapes', async () => {
  const schema = z
    .object({
      receipt: z.object({ id: z.string() }).strict(),
      rows: z.array(z.object({ snapshotText: z.string() })),
    })
    .strict();
  let captured: RegisteredResponseProbe | undefined;
  await assert.rejects(
    probeRegisteredResponse(
      response({
        data: {
          receipt: { id: 42, [canary]: canary },
          rows: [{ snapshotText: 42 }],
          [canary]: canary,
        },
      }),
      'target-submit',
      scope,
      (x) => schema.parse((x as { data: unknown }).data),
      (p) => {
        captured = p;
      },
    ),
    z.ZodError,
  );
  assert.equal(captured?.stage, 'schema-parse');
  assert.equal(captured?.errorClass, 'ZodError');
  assert.equal(captured?.shape.receiptObject, true);
  assert.equal(captured?.shape.rowsArray, true);
  assert(captured!.issues.some((x) => x.path.join('.') === 'receipt.id'));
  assert(!JSON.stringify(captured).includes(canary));
  const error = new z.ZodError(
    Array.from({ length: 6 }, () => ({
      code: 'custom',
      path: [canary, ...Array(10).fill('receipt')],
      message: canary,
    })),
  );
  await assert.rejects(
    probeRegisteredResponse(
      response({ data: { data: {} } }),
      'saved-targets',
      scope,
      () => {
        throw error;
      },
      (p) => {
        captured = p;
      },
    ),
    (e) => e === error,
  );
  assert.equal(captured?.issues.length, 4);
  assert.equal(captured?.issues[0]?.path.length, 8);
  assert.equal(captured?.issues[0]?.path[0], 'other');
  assert.equal(captured?.shape.nestedData, true);
});
test('missing data and null envelopes preserve original decoder errors and IO cannot mask them', async () => {
  const original = new Error(canary);
  await assert.rejects(
    probeRegisteredResponse(
      response({}),
      'target-submit',
      scope,
      () => {
        throw original;
      },
      () => {
        throw new Error('private IO');
      },
    ),
    (e) => e === original,
  );
  await assert.rejects(
    probeRegisteredResponse(
      response(null),
      'target-submit',
      scope,
      (x) => (x as { data: unknown }).data,
      () => {},
    ),
    TypeError,
  );
});
test('request matching exposes only equality bits for exact body/header scope', () => {
  const expected = { tenantId: canary, actorId: canary };
  const headers = {
    'x-tenant-id': canary,
    'x-expected-actor-id': canary,
    'idempotency-key': canary,
  };
  assert.deepEqual(
    registeredResponseScope(
      headers,
      expected,
      JSON.stringify({ kind: 'register_target', operationKey: canary }),
    ),
    { tenantMatches: true, actorMatches: true, bodyKindMatches: true, operationKeyMatches: true },
  );
  const bits = registeredResponseScope({}, expected, '{');
  assert.deepEqual(bits, {
    tenantMatches: false,
    actorMatches: false,
    bodyKindMatches: false,
    operationKeyMatches: false,
  });
  assert(!JSON.stringify(bits).includes(canary));
});
test('strict schema rejects extra raw properties and unapproved issue paths/codes', () => {
  assert.equal(registeredResponseProbeSchema.safeParse({ rawBody: canary }).success, false);
});
