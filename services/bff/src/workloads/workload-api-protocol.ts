import type { MethodDefinition } from '@grpc/grpc-js';
import { fromJSON, type MessageTypeDefinition } from '@grpc/proto-loader';

// Fixed subset of the SPIFFE Workload API wire contract, not a token-supplied
// service/descriptor. https://github.com/spiffe/spiffe/blob/main/standards/workloadapi.proto
export type BundleResponse = { bundles: Record<string, Buffer> };
const bundleMap = { keyType: 'string', type: 'bytes', id: 1 };
const definition = fromJSON(
  {
    nested: {
      JWTBundlesResponse: { fields: { bundles: bundleMap } },
    },
  },
  { bytes: Buffer, objects: true },
).JWTBundlesResponse as MessageTypeDefinition<BundleResponse, BundleResponse>;
export const fetchJwtBundles: MethodDefinition<Record<string, never>, BundleResponse> = {
  path: '/SpiffeWorkloadAPI/FetchJWTBundles',
  requestStream: false,
  responseStream: true,
  requestSerialize: () => Buffer.alloc(0),
  requestDeserialize: () => ({}),
  responseSerialize: definition.serialize,
  responseDeserialize: definition.deserialize,
};

export type SvidRequest = { audience: string[]; spiffeId: string };
export type SvidResponse = { svids: Array<{ spiffeId: string; svid: string; hint?: string }> };
const svidDefinitions = fromJSON(
  {
    nested: {
      JWTSVIDRequest: {
        fields: {
          audience: { rule: 'repeated', type: 'string', id: 1 },
          spiffeId: { type: 'string', id: 2 },
        },
      },
      JWTSVID: {
        fields: {
          spiffeId: { type: 'string', id: 1 },
          svid: { type: 'string', id: 2 },
          hint: { type: 'string', id: 3 },
        },
      },
      JWTSVIDResponse: { fields: { svids: { rule: 'repeated', type: 'JWTSVID', id: 1 } } },
    },
  },
  { arrays: true },
);
const svidRequest = svidDefinitions.JWTSVIDRequest as MessageTypeDefinition<
  SvidRequest,
  SvidRequest
>;
const svidResponse = svidDefinitions.JWTSVIDResponse as MessageTypeDefinition<
  SvidResponse,
  SvidResponse
>;
export const fetchJwtSvid: MethodDefinition<SvidRequest, SvidResponse> = {
  path: '/SpiffeWorkloadAPI/FetchJWTSVID',
  requestStream: false,
  responseStream: false,
  requestSerialize: svidRequest.serialize,
  requestDeserialize: svidRequest.deserialize,
  responseSerialize: svidResponse.serialize,
  responseDeserialize: svidResponse.deserialize,
};

/** Fixed streaming X509 subset. No federation or CRL is silently discarded. */
export interface X509SvidResponse {
  svids: Array<{
    spiffeId: string;
    x509Svid: Buffer;
    x509SvidKey: Buffer;
    bundle: Buffer;
    hint?: string;
  }>;
  crl: Buffer[];
  federatedBundles: Record<string, Buffer>;
}
const federatedBundleMap = { keyType: 'string', type: 'bytes', id: 3 };
const x509Definitions = fromJSON(
  {
    nested: {
      X509SVID: {
        fields: {
          spiffeId: { type: 'string', id: 1 },
          x509Svid: { type: 'bytes', id: 2 },
          x509SvidKey: { type: 'bytes', id: 3 },
          bundle: { type: 'bytes', id: 4 },
          hint: { type: 'string', id: 5 },
        },
      },
      X509SVIDResponse: {
        fields: {
          svids: { rule: 'repeated', type: 'X509SVID', id: 1 },
          crl: { rule: 'repeated', type: 'bytes', id: 2 },
          federatedBundles: federatedBundleMap,
        },
      },
    },
  },
  { bytes: Buffer, arrays: true, objects: true },
);
const x509Response = x509Definitions.X509SVIDResponse as MessageTypeDefinition<
  X509SvidResponse,
  X509SvidResponse
>;
export const fetchX509Svid: MethodDefinition<Record<string, never>, X509SvidResponse> = {
  path: '/SpiffeWorkloadAPI/FetchX509SVID',
  requestStream: false,
  responseStream: true,
  requestSerialize: () => Buffer.alloc(0),
  requestDeserialize: () => ({}),
  responseSerialize: x509Response.serialize,
  responseDeserialize: x509Response.deserialize,
};
