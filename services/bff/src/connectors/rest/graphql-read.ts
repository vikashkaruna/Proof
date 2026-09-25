import type {
  ConnectorInvocation,
  ConnectorManifest,
  ConnectorResult,
  ReadConnector,
} from '@axiom/types';
import type { AcquiredToken } from '../broker/oauth-grants.js';
import { profileField } from '../profile.js';
import {
  CURSOR,
  RestConnectorRefused,
  RestEndpointSchema,
  flatten,
  requestJson,
  type Fetch,
  type RestEndpoint,
} from './rest-read.js';

type Resource = NonNullable<ConnectorManifest['graphql']>['resources'][string];
const MAX_SAMPLE = 100;
const MAX_FIELDS = 200;

type Tree = Map<string, Tree>;
function selection(paths: readonly string[][]): string {
  const root: Tree = new Map();
  for (const path of paths) {
    let node = root;
    for (const name of path) {
      if (!node.has(name)) node.set(name, new Map());
      node = node.get(name)!;
    }
  }
  const render = (node: Tree): string =>
    [...node]
      .map(([name, child]) => (child.size ? `${name} { ${render(child)} }` : name))
      .join(' ');
  return render(root);
}

/** Builds the only query document this connector sends. Every name was
 * validated by the manifest schema; values travel as variables, never text. */
export function discoveryQuery(resource: Resource): string {
  const variables = ['$limit: Int!', ...(resource.cursorArg ? ['$cursor: String'] : [])];
  const args = [
    `${resource.pageSizeArg}: $limit`,
    ...(resource.cursorArg ? [`${resource.cursorArg}: $cursor`] : []),
  ];
  const body = selection([
    ...resource.fields.map((field) => [...resource.itemsPath, ...field.split('.')]),
    ...(resource.cursorPath ? [resource.cursorPath] : []),
  ]);
  return `query AxiomDiscovery(${variables.join(', ')}) { ${resource.root}(${args.join(', ')}) { ${body} } }`;
}

function walk(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const name of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, name)) return undefined;
    current = (current as Record<string, unknown>)[name];
  }
  return current;
}

/**
 * W4.7 GraphQL read transport (Drishti discovery). The descriptor declares a
 * root field, pagination arguments and a field selection; Axiom generates the
 * query, so no descriptor or caller supplies query text and no mutation can be
 * expressed. Transport limits are shared with REST. A response with GraphQL
 * errors is refused rather than partially profiled.
 */
export class GraphqlReadConnector implements ReadConnector {
  constructor(
    private readonly manifest: ConnectorManifest,
    private readonly endpoint: RestEndpoint,
    private readonly token: (context: ConnectorInvocation) => Promise<AcquiredToken>,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (manifest.transport !== 'graphql' || !manifest.graphql)
      throw new RestConnectorRefused('descriptor');
    if (!RestEndpointSchema.safeParse(endpoint).success) throw new RestConnectorRefused('endpoint');
  }

  private async query(context: ConnectorInvocation, name: string, limit: number, cursor?: string) {
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline) || deadline <= this.now())
      throw new RestConnectorRefused('deadline');
    const resources = this.manifest.graphql!.resources;
    if (!Object.prototype.hasOwnProperty.call(resources, name))
      throw new RestConnectorRefused('resource');
    const resource = resources[name]!;
    if (cursor !== undefined && (!resource.cursorArg || !CURSOR.test(cursor)))
      throw new RestConnectorRefused('cursor');
    const document = await requestJson(
      this.fetchImpl,
      new URL(this.manifest.graphql!.path, this.endpoint.baseUrl),
      await this.token(context),
      deadline,
      this.now,
      {
        method: 'POST',
        body: JSON.stringify({
          query: discoveryQuery(resource),
          variables: { limit, ...(cursor !== undefined ? { cursor } : {}) },
        }),
      },
    );
    if (walk(document, ['errors']) !== undefined) throw new RestConnectorRefused('graphql_errors');
    const root = walk(document, ['data', resource.root]);
    const items = resource.itemsPath.length ? walk(root, resource.itemsPath) : root;
    if (!Array.isArray(items)) throw new RestConnectorRefused('malformed');
    const next = resource.cursorPath ? walk(root, resource.cursorPath) : undefined;
    return {
      resource,
      items: items.slice(0, limit),
      ...(typeof next === 'string' && CURSOR.test(next) ? { next } : {}),
    };
  }

  /** Declared resources with the declared fields confirmed present in one page. */
  async enumerate(context: ConnectorInvocation): Promise<ConnectorResult> {
    const records = [];
    for (const name of Object.keys(this.manifest.graphql!.resources).sort()) {
      const { items, resource } = await this.query(context, name, 5);
      const observed = new Set<string>();
      for (const item of items) for (const key of flatten(item).keys()) observed.add(key);
      records.push({
        resource: name,
        fields: [...observed].sort(),
        missing: resource.fields.filter((f) => !observed.has(f)).sort(),
      });
    }
    return { records };
  }

  /** Value-shape counts per declared field over up to `limit` items. */
  async sample(
    context: ConnectorInvocation,
    resource: string,
    limit: number,
    cursor?: string,
  ): Promise<ConnectorResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAMPLE)
      throw new RestConnectorRefused('limit');
    const { items, next, resource: declared } = await this.query(context, resource, limit, cursor);
    const flattened = items.map((item) => flatten(item));
    const records = declared.fields
      .slice(0, MAX_FIELDS)
      .sort()
      .map((field) =>
        profileField(
          field,
          flattened.map((item) => item.get(field)),
        ),
      );
    return next ? { records, cursor: next } : { records };
  }

  /** Raw record reads stay disabled until the redaction pipeline covers them. */
  async read(): Promise<ConnectorResult> {
    throw new RestConnectorRefused('raw_read_disabled');
  }
}
