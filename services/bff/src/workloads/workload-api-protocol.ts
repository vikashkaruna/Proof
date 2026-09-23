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
