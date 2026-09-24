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
