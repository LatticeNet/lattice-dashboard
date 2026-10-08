/**
 * Evidence Collection's query fields (src/lib/query) over the per-node trace
 * policy table: the shared node fields, reached through the policy's node,
 * plus what the table shows per node.
 *
 *   -is:trace readiness:not_ready sort:name
 *
 * The field lives at `?collection.q=`, never `?q=`: Evidence keeps one
 * address for all its layers, and `?q=` is Explore's free text.
 *
 * Pure, like the sibling model: no Vue, no i18n.
 */
import type { Node, TracePolicy } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { nodeBareMatch, nodeQueryFields, nodeQueryText } from "@/lib/query/nodeFields";
import type { CoverageRow } from "@/views/platform/evidenceModel";

export const COLLECTION_QUERY_PARAM = "collection.q";

export const TRACE_QUERY_LEVELS = ["info", "debug", "trace"] as const;
export const READINESS_KINDS = ["ready", "not_ready", "pending", "waiting", "stale", "off"] as const;

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const COLLECTION_QUERY_EXAMPLES = [
  { key: "notReady", query: "readiness:not_ready,stale sort:name" },
  { key: "capturing", query: "is:capturing" },
  { key: "heavy", query: "held>100000 sort:-held" },
  { key: "untraced", query: "-is:trace tag:edge" },
] as const;

const hint = (key: string) => `platform.evidence.collection.query.fields.${key}`;

export interface CollectionQueryOptions {
  nodeOf: (policy: TracePolicy) => Node | undefined;
  coverageOf: (policy: TracePolicy) => CoverageRow | undefined;
  /** The row has unsaved changes. */
  edited: (policy: TracePolicy) => boolean;
  /** The node's name when the fleet list does not hold it. */
  nameOf: (nodeId: string) => string;
}

export function collectionQuerySchema(options: CollectionQueryOptions): QuerySchema<TracePolicy> {
  const cover =
    <V>(get: (row: CoverageRow) => V) =>
    (policy: TracePolicy): V | undefined => {
      const row = options.coverageOf(policy);
      return row ? get(row) : undefined;
    };
  const page: QueryField<TracePolicy>[] = [
    { key: "trace", aliases: ["enabled"], type: "bool", flag: true, hint: hint("trace"), get: (p) => p.enabled, sort: false },
    { key: "level", type: "enum", hint: hint("level"), values: TRACE_QUERY_LEVELS, get: (p) => p.level },
    { key: "budget", type: "number", hint: hint("budget"), get: (p) => p.budget_lines_per_sec },
    {
      key: "readiness",
      aliases: ["ready"],
      type: "enum",
      hint: hint("readiness"),
      values: READINESS_KINDS,
      valueAliases: { "not-ready": "not_ready", notready: "not_ready" },
      get: cover((row) => row.readiness?.kind),
    },
    { key: "capturing", type: "bool", flag: true, hint: hint("capturing"), get: cover((row) => row.capturing > 0), sort: false },
    { key: "captures", type: "number", hint: hint("captures"), get: cover((row) => row.capturing) },
    { key: "sources", type: "number", hint: hint("sources"), get: cover((row) => (row.sourcesKnown ? row.sources.length : undefined)) },
    { key: "held", aliases: ["lines"], type: "number", hint: hint("held"), get: cover((row) => row.heldLines) },
    { key: "raw", type: "bool", flag: true, hint: hint("raw"), get: cover((row) => row.rawLines), sort: false },
    { key: "quiet", aliases: ["idle"], type: "bool", flag: true, hint: hint("quiet"), get: cover((row) => row.quiet), sort: false },
    { key: "edited", type: "bool", flag: true, hint: hint("edited"), get: (p) => options.edited(p), sort: false },
  ];
  return {
    fields: [...page, ...nodeQueryFields(options.nodeOf, { identity: (p) => ({ id: p.node_id, name: options.nameOf(p.node_id) }) })],
    text: (policy) => {
      const node = options.nodeOf(policy);
      return node ? nodeQueryText(node) : [options.nameOf(policy.node_id), policy.node_id];
    },
    bare: nodeBareMatch(options.nodeOf),
  };
}
