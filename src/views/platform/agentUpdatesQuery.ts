/**
 * Agent updates' query fields (src/lib/query): the shared node fields,
 * reached through the row's node, plus what this page knows per row: how the
 * agent stands against the latest release, its update policy, and the plans
 * that policy made.
 *
 *   is:behind -policy:auto sort:name
 *
 * Pure, like the sibling model: no Vue, no i18n.
 */
import type { AgentUpdatePolicy, Node } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { nodeBareMatch, nodeQueryFields, nodeQueryText } from "@/lib/query/nodeFields";
import type { AgentStanding } from "@/views/platform/agentUpdatesModel";

/** What a row of the fleet table holds. */
export interface AgentUpdateRow {
  nodeId: string;
  name: string;
  standing: AgentStanding;
  policy?: AgentUpdatePolicy;
}

/** Behind first: the rows the page exists for. */
export const AGENT_STANDINGS: readonly AgentStanding[] = ["behind", "current", "ahead", "unknown"];
export const AGENT_POLICY_STATES = ["none", "manual", "auto", "disabled"] as const;
export type AgentPolicyState = (typeof AGENT_POLICY_STATES)[number];

export function agentPolicyState(policy: AgentUpdatePolicy | undefined): AgentPolicyState {
  if (!policy) return "none";
  if (!policy.enabled) return "disabled";
  return policy.auto_plan ? "auto" : "manual";
}

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const AGENT_UPDATES_QUERY_EXAMPLES = [
  { key: "behind", query: "is:behind -policy:auto sort:name" },
  { key: "none", query: "policy:none" },
  { key: "failed", query: "is:failed sort:-planned" },
  { key: "quiet", query: "planned>7d" },
] as const;

const hint = (key: string) => `platform.agentUpdatesPage.query.fields.${key}`;

export interface AgentUpdatesQueryOptions<R> {
  nodeOf: (row: R) => Node | undefined;
  /** The target the Target column prints. */
  target: (row: R) => string;
  /** Approvals this row's policy left behind that no longer apply. */
  staleApprovals: (row: R) => number;
}

export function agentUpdatesQuerySchema<R extends AgentUpdateRow>(options: AgentUpdatesQueryOptions<R>): QuerySchema<R> {
  const page: QueryField<R>[] = [
    { key: "standing", type: "enum", hint: hint("standing"), values: AGENT_STANDINGS, get: (row) => row.standing },
    {
      key: "policy",
      type: "enum",
      hint: hint("policy"),
      values: AGENT_POLICY_STATES,
      valueAliases: { off: "disabled", automatic: "auto" },
      get: (row) => agentPolicyState(row.policy),
    },
    { key: "target", type: "string", hint: hint("target"), get: (row) => (row.policy ? options.target(row) : undefined) },
    { key: "planned", aliases: ["last_planned"], type: "time", hint: hint("planned"), get: (row) => row.policy?.last_planned_at },
    { key: "behind", type: "bool", flag: true, hint: hint("behind"), get: (row) => row.standing === "behind", sort: false },
    {
      key: "failed",
      aliases: ["error"],
      type: "bool",
      flag: true,
      hint: hint("failed"),
      get: (row) => !!row.policy?.last_error,
      sort: false,
    },
    { key: "stale", type: "bool", flag: true, hint: hint("stale"), get: (row) => options.staleApprovals(row) > 0, sort: false },
  ];
  return {
    fields: [...page, ...nodeQueryFields(options.nodeOf, { identity: (row) => ({ id: row.nodeId, name: row.name }) })],
    text: (row) => {
      const node = options.nodeOf(row);
      return node ? nodeQueryText(node) : [row.name, row.nodeId];
    },
    bare: nodeBareMatch(options.nodeOf),
  };
}
