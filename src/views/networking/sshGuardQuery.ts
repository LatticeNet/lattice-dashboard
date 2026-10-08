/**
 * The SSH Guard board's query fields (src/lib/query): every shared node field,
 * reached through the row's node, plus what the board knows about each row.
 *
 *   posture:password_open port:22 -is:gate sort:name
 *
 * The board fields read the same facts the row prints, folded once per
 * render by the view (`GuardRowFacts`), so a filter can never disagree with
 * the badge or the SSHD NOW cell beside it.
 *
 * Pure, like the sibling models: no Vue, no i18n.
 */
import type { Node, SSHGuardKnockKnowledge } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { nodeBareMatch, nodeQueryFields, nodeQueryText } from "@/lib/query/nodeFields";
import type { BoardStage, CoverageFilter, RealityEvidence, ScopeState, SshPosture } from "@/views/networking/sshGuardBoardModel";
import type { NodeGuardState } from "@/views/networking/sshGuardModel";

/** What the board has decided about one row, as the row prints it. */
export interface GuardRowFacts {
  /** The node, when the fleet list still holds it. */
  node?: Node;
  posture: SshPosture;
  /** The knock gate is on the box now. */
  gate: boolean;
  stage: BoardStage;
  /** The coverage chip the row counts under. */
  state: Exclude<CoverageFilter, "all">;
  scope: ScopeState;
  evidence?: RealityEvidence;
  knock: SSHGuardKnockKnowledge | string;
  /** A revert timer is running. */
  reverting: boolean;
  /** An arm plan can be written for it now. */
  armable: boolean;
}

/** Finding first, as the board orders rows. */
export const GUARD_POSTURES: readonly SshPosture[] = ["password_open", "partial", "unknown", "secured"];
/** Most urgent first. */
export const GUARD_STATES: readonly Exclude<CoverageFilter, "all">[] = ["reverting", "armPending", "failed", "open", "excluded", "confirmed"];
/** The rollout order, a reverted arm beside the failed ones. */
export const GUARD_STAGES: readonly BoardStage[] = [
  "awaitingConfirm",
  "confirmPending",
  "confirmApproved",
  "armApproved",
  "armPending",
  "armFailed",
  "reverted",
  "idle",
  "confirmed",
];
export const GUARD_SCOPES: readonly ScopeState[] = ["enrolled", "undecided", "excluded"];
export const GUARD_KNOCKS: readonly SSHGuardKnockKnowledge[] = ["installed", "installed_superseded", "planned", "no_knock", "unknown"];

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const SSH_GUARD_QUERY_EXAMPLES = [
  { key: "password", query: "posture:password_open sort:name" },
  { key: "legacy", query: "port:22 -is:gate" },
  { key: "stale", query: "observed>1h sort:observed" },
  { key: "trouble", query: "state:failed OR state:reverting" },
  { key: "ready", query: "tag:edge is:armable" },
] as const;

const hint = (key: string) => `networking.sshGuard.query.fields.${key}`;

export function sshGuardQuerySchema(
  facts: (state: NodeGuardState) => GuardRowFacts | undefined,
  options: { groupName?: (id: string) => string | undefined } = {},
): QuerySchema<NodeGuardState> {
  const nodeOf = (state: NodeGuardState) => facts(state)?.node;
  const fact =
    <V>(get: (f: GuardRowFacts) => V) =>
    (state: NodeGuardState): V | undefined => {
      const f = facts(state);
      return f ? get(f) : undefined;
    };
  const board: QueryField<NodeGuardState>[] = [
    {
      key: "posture",
      type: "enum",
      hint: hint("posture"),
      values: GUARD_POSTURES,
      // The chip says "Not reported"; the grammar's word is unknown.
      valueAliases: { password: "password_open", "password-open": "password_open", secure: "secured", not_reported: "unknown", "not-reported": "unknown" },
      get: fact((f) => f.posture),
    },
    {
      key: "state",
      aliases: ["coverage"],
      type: "enum",
      hint: hint("state"),
      values: GUARD_STATES,
      valueAliases: { pending: "armPending", "arm-pending": "armPending", "not-armed": "open", notarmed: "open" },
      get: fact((f) => f.state),
    },
    { key: "stage", type: "enum", hint: hint("stage"), values: GUARD_STAGES, get: fact((f) => f.stage) },
    { key: "scope", type: "enum", hint: hint("scope"), values: GUARD_SCOPES, get: fact((f) => f.scope) },
    {
      key: "port",
      aliases: ["ports", "sshd"],
      type: "number",
      hint: hint("port"),
      get: fact((f) => f.evidence?.sshd?.ports),
    },
    {
      key: "password",
      type: "bool",
      flag: true,
      hint: hint("password"),
      get: fact((f) => f.evidence?.password?.enabled),
      sort: false,
    },
    {
      key: "knock",
      type: "enum",
      hint: hint("knock"),
      values: GUARD_KNOCKS,
      valueAliases: { none: "no_knock", "no-knock": "no_knock", superseded: "installed_superseded" },
      get: fact((f) => f.knock),
    },
    {
      key: "observed",
      aliases: ["snapshot"],
      type: "time",
      hint: hint("observed"),
      get: fact((f) => f.evidence?.collectedAt),
    },
    { key: "gate", aliases: ["gated"], type: "bool", flag: true, hint: hint("gate"), get: fact((f) => f.gate), sort: false },
    { key: "reverting", type: "bool", flag: true, hint: hint("reverting"), get: fact((f) => f.reverting), sort: false },
    { key: "stale", type: "bool", flag: true, hint: hint("stale"), get: fact((f) => f.evidence?.status === "stale"), sort: false },
    {
      key: "legacy",
      type: "bool",
      flag: true,
      hint: hint("legacy"),
      get: fact((f) => (f.evidence?.sshd ? f.evidence.sshd.kind === "legacy" : undefined)),
      sort: false,
    },
    { key: "armable", type: "bool", flag: true, hint: hint("armable"), get: fact((f) => f.armable), sort: false },
  ];
  return {
    // The board's own fields first: they lead the menu and the help on this page.
    fields: [
      ...board,
      ...nodeQueryFields(nodeOf, { identity: (state) => ({ id: state.nodeId, name: state.name }), groupName: options.groupName }),
    ],
    text: (state) => {
      const node = nodeOf(state);
      return node ? nodeQueryText(node) : [state.name, state.nodeId];
    },
    bare: nodeBareMatch(nodeOf),
  };
}
