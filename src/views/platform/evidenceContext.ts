/**
 * What every Evidence layer reads, loaded once by the page and handed down
 * with provide/inject: the nodes and users for names, the trace policies, the
 * capture sessions, the trace store stats, the raw log sources with their
 * stats, and the last hour of connection records the Overview summarises.
 *
 * One copy, because the layers answer consecutive questions about the same
 * facts. The proof line, the coverage table and the capture history must not
 * disagree about which nodes collect, and they cannot if they read one list.
 */
import { computed, inject, provide, ref, type ComputedRef, type InjectionKey, type Ref } from "vue";

import {
  api,
  ApiError,
  unwrap,
  type ConnRecord,
  type LogSource,
  type LogSourceStatsView,
  type Node,
  type TracePolicy,
  type TraceSession,
  type TraceStatsResponse,
} from "@/lib/api";
import { useAsyncData, type AsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";

import {
  evidenceCoverageRows,
  evidenceStoreProof,
  summarizeLastHour,
  type CoverageRow,
  type EvidenceTokenResolvers,
  type LastHourSummary,
  type StoreProof,
} from "./evidenceModel";

/** Pages of the last-hour sample, at the endpoint's ceiling of 1000 each. */
const LAST_HOUR_PAGE = 1000;
const LAST_HOUR_MAX_PAGES = 3;

export interface LastHourSample {
  records: ConnRecord[];
  /** The sample stopped with a cursor still pending. */
  capped: boolean;
  /** What the store holds for every visible node; undefined from an older server. */
  collectedTotal?: number;
  collectedNewestAt: string;
}

export interface EvidenceContext {
  canRead: ComputedRef<boolean>;
  canAdmin: ComputedRef<boolean>;
  canReadNodes: ComputedRef<boolean>;
  nodes: ComputedRef<Node[]>;
  nodesQuery: AsyncData<Node[]>;
  nodeLabel: (id: string) => string;
  userNames: ComputedRef<Map<string, string>>;
  policies: AsyncData<TracePolicy[]>;
  sessions: AsyncData<TraceSession[]>;
  stats: AsyncData<TraceStatsResponse>;
  sources: AsyncData<LogSource[]>;
  logStats: AsyncData<LogSourceStatsView[]>;
  lastHour: AsyncData<LastHourSample>;
  lastHourSummary: ComputedRef<LastHourSummary | undefined>;
  /** False only when the server said tracing is not enabled (503). */
  storeReady: ComputedRef<boolean>;
  coverageRows: ComputedRef<CoverageRow[]>;
  coverageKnown: ComputedRef<boolean>;
  storeProof: ComputedRef<StoreProof>;
  resolvers: ComputedRef<EvidenceTokenResolvers>;
  /**
   * Every list a name in the query field resolves against has answered
   * (loaded or failed). Before that, `node:legend-sg` would be sent as a
   * literal id and match nothing.
   */
  namesReady: ComputedRef<boolean>;
  /** A list names resolve against has no data (failed, or not answered yet). */
  namesUnchecked: ComputedRef<boolean>;
  /** Bumped by the page's Refresh button, for lists that do not poll. */
  refreshTick: Ref<number>;
  refreshAll: () => void;
}

const KEY: InjectionKey<EvidenceContext> = Symbol("evidence");

export function useEvidenceContext(): EvidenceContext {
  const ctx = inject(KEY);
  if (!ctx) throw new Error("Evidence layer rendered outside EvidenceView");
  return ctx;
}

export function provideEvidenceContext(): EvidenceContext {
  const auth = useAuthStore();
  const canRead = computed(() => auth.can("log:read"));
  const canAdmin = computed(() => auth.can("log:admin"));
  const canReadNodes = computed(() => auth.can("node:read"));
  const canReadUsers = computed(() => auth.can("user:admin"));

  const nodesQuery = useAsyncData(
    (signal) =>
      canReadNodes.value
        ? api.nodes.list({ signal }).then((r) => unwrap(r, "nodes"))
        : Promise.resolve([] as Node[]),
    { immediate: canReadNodes.value },
  );
  const nodes = computed(() => nodesQuery.data.value ?? []);

  function nodeLabel(id: string): string {
    if (!id) return "";
    return nodes.value.find((node) => node.id === id)?.name || shortId(id, 12);
  }

  // Lattice user id to display name, when the operator can read the
  // directory. Without user:admin a managed row shows the u_<hex> name
  // sing-box logged instead, which is real evidence.
  const usersQuery = useAsyncData(
    (signal) =>
      canReadUsers.value
        ? api.users.list({ signal }).then((r) => unwrap(r, "users"))
        : Promise.resolve([]),
    { immediate: canReadUsers.value },
  );
  const userNames = computed(() => {
    const map = new Map<string, string>();
    for (const user of usersQuery.data.value ?? []) map.set(user.id, user.username);
    return map;
  });

  const policies = useAsyncData(
    (signal) =>
      canRead.value
        ? api.trace.policy(undefined, { signal }).then((r) => r.policies ?? [])
        : Promise.resolve([] as TracePolicy[]),
    { pollInterval: 30000, immediate: canRead.value },
  );
  const sessions = useAsyncData(
    (signal) =>
      canRead.value
        ? api.trace.sessions({ signal }).then((r) => r.sessions ?? [])
        : Promise.resolve([] as TraceSession[]),
    { pollInterval: 10000, immediate: canRead.value },
  );
  const stats = useAsyncData(
    (signal) => (canRead.value ? api.trace.stats({ signal }) : Promise.resolve({} as TraceStatsResponse)),
    { pollInterval: 30000, immediate: canRead.value },
  );
  const sources = useAsyncData(
    (signal) =>
      canRead.value
        ? api.logs.sources({ signal }).then((r) => unwrap(r, "sources"))
        : Promise.resolve([] as LogSource[]),
    { pollInterval: 15000, immediate: canRead.value },
  );
  const logStats = useAsyncData(
    (signal) =>
      canRead.value
        ? api.logs.stats(undefined, { signal }).then((r) => unwrap(r, "stats"))
        : Promise.resolve([] as LogSourceStatsView[]),
    { pollInterval: 15000, immediate: canRead.value },
  );

  // The last hour, paged to a ceiling. It feeds the Overview's numbers and
  // the per-node column, and its collected_total is the record count an
  // operator without fleet-wide stats still gets.
  const lastHour = useAsyncData<LastHourSample>(
    async (signal) => {
      if (!canRead.value) return { records: [], capped: false, collectedNewestAt: "" };
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const records: ConnRecord[] = [];
      let cursor = "";
      let collectedTotal: number | undefined;
      let collectedNewestAt = "";
      for (let page = 0; page < LAST_HOUR_MAX_PAGES; page++) {
        const params: Record<string, string | number> = { since, limit: LAST_HOUR_PAGE, include_open: "true" };
        if (cursor) params.cursor = cursor;
        const res = await api.trace.connections(params, { signal });
        records.push(...(res.records ?? []));
        collectedTotal = res.collected_total ?? collectedTotal;
        collectedNewestAt = res.collected_newest_at || collectedNewestAt;
        cursor = (res.next_cursor ?? "").trim();
        if (!cursor) break;
      }
      return { records, capped: cursor !== "", collectedTotal, collectedNewestAt };
    },
    { pollInterval: 30000, immediate: canRead.value },
  );
  const lastHourSummary = computed(() => {
    const sample = lastHour.data.value;
    if (!sample || sample.records.length === 0) return undefined;
    return summarizeLastHour(sample.records, sample.capped);
  });

  const storeReady = computed(() => !(stats.error.value instanceof ApiError && stats.error.value.status === 503));

  const coverageKnown = computed(() => policies.data.value !== undefined && !policies.error.value);
  const coverageRows = computed(() =>
    evidenceCoverageRows({
      nodes: nodes.value,
      policies: coverageKnown.value ? policies.data.value : undefined,
      sessions: sessions.data.value ?? [],
      sources: sources.data.value ?? [],
      sourcesKnown: sources.data.value !== undefined && !sources.error.value,
      traceUnavailable: !storeReady.value,
      stats: logStats.data.value ?? [],
      lastHourByNode: lastHourSummary.value?.byNode ?? (lastHour.data.value ? new Map() : undefined),
      nowMs: Date.now(),
    }),
  );
  const storeProof = computed(() =>
    evidenceStoreProof({
      stats: stats.error.value ? undefined : stats.data.value,
      collectedTotal: lastHour.error.value ? undefined : lastHour.data.value?.collectedTotal,
      rows: coverageRows.value,
      coverageKnown: coverageKnown.value,
    }),
  );

  const settled = (query: AsyncData<unknown>) => query.data.value !== undefined || !!query.error.value;
  const namesReady = computed(
    () =>
      (!canReadNodes.value || settled(nodesQuery)) &&
      (!canReadUsers.value || settled(usersQuery)) &&
      (!canRead.value || (settled(policies) && settled(sources))),
  );

  // A list that failed still settles namesReady, so a search never waits on
  // it; the names it would have resolved are then reported as unchecked
  // rather than as names that do not exist.
  const namesUnchecked = computed(
    () =>
      (canReadNodes.value && nodesQuery.data.value === undefined) ||
      (canReadUsers.value && usersQuery.data.value === undefined) ||
      (canRead.value && sources.data.value === undefined),
  );

  const resolvers = computed<EvidenceTokenResolvers>(() => {
    const byName = new Map<string, string>();
    const ids = new Set<string>();
    for (const node of nodes.value) {
      ids.add(node.id);
      if (node.name) byName.set(node.name.toLowerCase(), node.id);
    }
    // Nodes the policy list names count as known even without node:read.
    for (const policy of policies.data.value ?? []) ids.add(policy.node_id);
    const userByName = new Map<string, string>();
    for (const [id, name] of userNames.value) userByName.set(name.toLowerCase(), id);
    const sourceList = sources.data.value ?? [];
    return {
      nodeId: (value) => (ids.has(value) ? value : byName.get(value.toLowerCase())),
      nodeLabel: (id) => nodes.value.find((node) => node.id === id)?.name || id,
      // Without the directory a user id cannot be checked, so it passes as typed.
      userId: canReadUsers.value
        ? (value) => (userNames.value.has(value) ? value : userByName.get(value.toLowerCase()))
        : undefined,
      userLabel: (id) => userNames.value.get(id) || id,
      sourceId: (value) =>
        sourceList.find((source) => source.id === value)?.id ??
        sourceList.find((source) => (source.name || "").toLowerCase() === value.toLowerCase())?.id,
      sourceLabel: (id) => sourceList.find((source) => source.id === id)?.name || id,
    };
  });

  const refreshTick = ref(0);

  function refreshAll(): void {
    if (!canRead.value) return;
    refreshTick.value++;
    policies.refresh();
    sessions.refresh();
    stats.refresh();
    sources.refresh();
    logStats.refresh();
    lastHour.refresh();
    if (canReadNodes.value) nodesQuery.refresh();
  }

  const ctx: EvidenceContext = {
    canRead,
    canAdmin,
    canReadNodes,
    nodes,
    nodesQuery,
    nodeLabel,
    userNames,
    policies,
    sessions,
    stats,
    sources,
    logStats,
    lastHour,
    lastHourSummary,
    storeReady,
    coverageRows,
    coverageKnown,
    storeProof,
    resolvers,
    namesReady,
    namesUnchecked,
    refreshTick,
    refreshAll,
  };
  provide(KEY, ctx);
  return ctx;
}
