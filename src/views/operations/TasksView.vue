<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Funnel,
  KeyRound,
  ListChecks,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-vue-next";
import { api, unwrap, type CapabilityImpact, type Node, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useStepUp } from "@/composables/useStepUp";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { tokenMatchesText } from "@/lib/filterExpressions";
import { cn } from "@/lib/utils";
import {
  agentConfigBadges,
  evalFilterExpression,
  nodeMatchesTargetToken,
} from "@/lib/nodeFilterExpressions";

import PageHeader from "@/components/common/PageHeader.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusFilter = "all" | TaskView["status"];
type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
type NodeRunStatus = "queued" | "leased" | "finished" | "failed" | "cancelled" | "expired";

interface Attempt {
  task: TaskView;
  result?: TaskResult;
}

interface NodeExecutionRow {
  nodeId: string;
  node?: Node;
  attempts: Attempt[];
  latestTask?: TaskView;
  latestResult?: TaskResult;
  status: NodeRunStatus;
  failed: boolean;
}

/**
 * A starting point for a probe script, offered rather than imposed.
 *
 * The obvious systemic fix for the failure this console kept producing - a
 * survey that measured nothing and reported exit 0 - is to inject `set -eu`
 * into every script. It does not work: `echo "k=$(cmd)"` succeeds whatever cmd
 * does, because errexit only fires when the substitution's status becomes the
 * command's, and every line of a probe script has that shape. It would break
 * the semantics of scripts already written and tested while catching nothing.
 *
 * So the pattern is offered as text the operator can read, edit, or delete:
 * resolve the binary rather than assume its path, capture once rather than
 * re-run per field, say what could not be measured, and exit non-zero when
 * nothing was, so the task's own failed count means something.
 */
const SURVEY_TEMPLATE = `# Probe template. Edit freely - this is a starting point, not a contract.
probe=ok
note=

# Resolve rather than assume: the same tool sits in different places across
# distributions, and a hardcoded path fails into an empty field.
BIN=
for c in /usr/sbin/sshd /usr/bin/sshd; do [ -x "$c" ] && BIN="$c" && break; done
[ -z "$BIN" ] && probe=missing-binary && note="sshd not found"

# Capture ONCE. Re-running a probe per field costs a re-parse each time and
# lets the fields describe different moments.
OUT=
if [ -n "$BIN" ]; then
  if OUT=$("$BIN" -T 2>&1) && [ -n "$OUT" ]; then :; else
    probe=probe-failed
    note=$(printf '%s' "$OUT" | head -1)
    OUT=
  fi
fi
# Most privileged probes read nothing as a non-root user and say so only on
# stderr, which a $(... 2>/dev/null) swallows.
[ "$(id -u)" != 0 ] && note="\${note:+$note; }not root (uid $(id -u))"

field() { [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed -n "s/^$1 //p" | sort -u | tr '\n' ','; }

echo "host=$(hostname)"
echo "probe=$probe"
echo "note=$note"
echo "uid=$(id -u)"
echo "port=$(field port)"

# Make an unmeasured run count as one. Without this the task reports exit 0 and
# reads exactly like a run that measured everything.
[ "$probe" = ok ] || exit 3
`;

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const canRunTasks = computed(() => auth.can("task:run"));

const versionQuery = useAsyncData(() => api.version(), { pollInterval: 60000 });
const taskExecutionDisabled = computed(() => !!versionQuery.data.value?.task_execution_disabled);

const tasksQuery = useAsyncData<TaskView[] | undefined>(
  () => api.tasks.list().then((r) => unwrap(r, "tasks")),
  { pollInterval: 5000 },
);
const resultsQuery = useAsyncData<TaskResult[] | undefined>(
  () => api.tasks.results().then((r) => unwrap(r, "results")),
  { pollInterval: 5000 },
);
const nodesQuery = useAsyncData<Node[] | undefined>(
  () => api.nodes.list().then((r) => unwrap(r, "nodes")),
  { pollInterval: 5000 },
);

/** Capabilities an operator may confine a task to. Only the enforced ones are
 *  offered: declaring an unenforced one would narrow nothing and read as a
 *  guarantee it cannot keep. */
const declarableQuery = useAsyncData<CapabilityImpact[] | undefined>(
  () => api.capabilities.list().then((r) => (r.capabilities ?? []).filter((c) => c.enforced)),
  { pollInterval: 60000 },
);
const declarableCapabilities = computed(() => declarableQuery.data.value ?? []);
const statusFilter = ref<StatusFilter>("all");
{
  const seeded = route.query.status;
  if (seeded === "queued" || seeded === "leased" || seeded === "finished" || seeded === "failed" || seeded === "cancelled" || seeded === "expired") {
    statusFilter.value = seeded;
  }
}

const targetSearch = ref("");
const targetTag = ref("all");
const targetRegion = ref("all");
const targetExpr = ref("");
const selectedTargets = ref<string[]>([]);
const interpreter = ref("sh");
/**
 * An optional capability to confine this task to.
 *
 * It only ever narrows the target set. Nothing can verify that a script "is" a
 * sing-box script, so declaring one is a promise about your own intent - safe
 * to honour as a restriction, worthless as a grant. What it buys is that a
 * fleet-wide probe aimed at sing-box nodes cannot quietly also hit the machines
 * that do not run it.
 */
const capability = ref("");
const script = ref("");
const timeoutSec = ref(60);
const outputLimit = ref(16384);
const taskSearch = ref("");
const taskExpression = ref("");
const expandedNodeRows = ref<Set<string>>(new Set());
const creating = ref(false);
const actionPending = ref<string | null>(null);
const revealedScripts = ref<Record<string, string>>({});
const revealingScriptID = ref("");
const deleteOpen = ref(false);
const deleteTarget = ref<TaskView | undefined>();

const stepUp = useStepUp({
  required: t("operations.tasks.stepUpRequired"),
  failed: t("operations.tasks.stepUpFailed"),
  passkeyFailed: t("operations.tasks.stepUpPasskeyFailed"),
});
const stepUpOpen = stepUp.open;
const stepUpCode = stepUp.code;
const stepUpError = stepUp.error;
const stepUpPending = stepUp.pending;

const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
const tasks = computed<TaskView[]>(() => tasksQuery.data.value ?? []);

/**
 * The run that is open in the detail drawer.
 *
 * A run's interesting part is per-node: which target failed, on which attempt,
 * with what output. That never fitted in a list (it used to be an accordion
 * inside a card), so reading one node's failure meant scrolling past every
 * other run's summary. The list is now a table that answers "which run" and
 * the drawer answers "what happened", which is the split the job actually has.
 */
const detailTaskId = ref("");
const detailTask = computed<TaskView | undefined>(() =>
  detailTaskId.value ? tasksById.value[detailTaskId.value] : undefined,
);
const detailOpen = computed({
  get: () => !!detailTask.value,
  set: (open: boolean) => {
    if (!open) detailTaskId.value = "";
  },
});

const taskColumns = computed<DataTableColumn<TaskView>[]>(() => [
  { key: "status", label: t("operations.tasks.colStatus"), sortable: true, class: "w-[7.5rem]" },
  { key: "task", label: t("operations.tasks.colTask"), sortable: true, searchable: true, value: (row) => row.id },
  {
    key: "targets",
    label: t("operations.tasks.colTargets"),
    searchable: true,
    value: (row) => row.targets.map((id) => nodeName(id)).join(" "),
  },
  { key: "progress", label: t("operations.tasks.targetProgress"), class: "w-[10rem]" },
  { key: "created_at", label: t("operations.tasks.colCreated"), sortable: true, align: "right", class: "w-[9rem]" },
  { key: "actions", label: "", align: "right", class: "w-[7rem]" },
]);
const results = computed<TaskResult[]>(() => resultsQuery.data.value ?? []);
const nodesById = computed<Record<string, Node>>(() => Object.fromEntries(nodes.value.map((n) => [n.id, n])));
const tasksById = computed<Record<string, TaskView>>(() => Object.fromEntries(tasks.value.map((task) => [task.id, task])));

const allTags = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) for (const tag of node.tags ?? []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

const allRegions = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) set.add(nodeRegion(node));
  return [...set].sort((a, b) => a.localeCompare(b));
});

const filteredTargetNodes = computed(() => {
  const q = targetSearch.value.trim().toLowerCase();
  return nodes.value
    .filter((node) => {
      if (targetTag.value !== "all" && !(node.tags ?? []).includes(targetTag.value)) return false;
      if (targetRegion.value !== "all" && nodeRegion(node) !== targetRegion.value) return false;
      if (targetExpr.value.trim() && !evalFilterExpression(targetExpr.value, (token) => nodeMatchesTargetToken(node, token)).value) return false;
      if (!q) return true;
      return [
        node.id,
        node.name,
        node.role,
        node.geo?.country,
        node.geo?.region,
        node.geo?.city,
        ...(node.tags ?? []),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
});

const selectedSet = computed(() => new Set(selectedTargets.value));

const resultsByTask = computed<Record<string, TaskResult[]>>(() => {
  const grouped: Record<string, TaskResult[]> = {};
  for (const result of results.value) {
    (grouped[result.task_id] ||= []).push(result);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => timeValue(b.finished_at) - timeValue(a.finished_at));
  }
  return grouped;
});

const childTasksByRoot = computed<Record<string, TaskView[]>>(() => {
  const grouped: Record<string, TaskView[]> = {};
  for (const task of tasks.value) {
    if (!task.rerun_of_task_id) continue;
    (grouped[task.rerun_of_task_id] ||= []).push(task);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => timeValue(a.created_at) - timeValue(b.created_at));
  }
  return grouped;
});

const rootTasks = computed(() =>
  tasks.value
    .filter((task) => !task.rerun_of_task_id || !tasksById.value[task.rerun_of_task_id])
    .sort((a, b) => timeValue(b.created_at) - timeValue(a.created_at)),
);

const taskExpressionError = computed(() => {
  const expr = taskExpression.value.trim();
  if (!expr) return "";
  const result = evalFilterExpression(expr, () => true);
  return result.ok ? "" : result.error ?? t("common.table.expressionInvalid");
});

function filterTextSlice(value?: string): string {
  return (value ?? "").slice(0, 4096);
}

function taskExpressionFieldValues(task: TaskView, rows: NodeExecutionRow[], rawField: string): string[] {
  const attempts = attemptTasks(task);
  const field = rawField.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (field) {
    case "id":
    case "task":
    case "task_id":
      return [task.id, shortId(task.id), ...attempts.map((attempt) => attempt.id), ...attempts.map((attempt) => shortId(attempt.id))];
    case "attempt":
    case "attempt_id":
      return attempts.map((attempt) => attempt.id);
    case "status":
    case "state":
      return [groupStatus(task, rows), task.status, ...rows.map((row) => row.status)];
    case "interpreter":
    case "shell":
      return [task.interpreter];
    case "node":
    case "node_id":
    case "target":
    case "target_id":
      return [
        ...task.targets,
        ...task.targets.map((id) => nodeName(id)),
        ...rows.map((row) => row.nodeId),
        ...rows.map((row) => row.node?.name ?? ""),
      ];
    case "actor":
    case "actor_id":
      return [task.actor_id ?? ""];
    case "token":
    case "token_id":
      return [task.token_id ?? ""];
    case "approval":
    case "approval_id":
      return [task.approval_id ?? ""];
    case "sha":
    case "script":
    case "script_sha256":
      return [task.script_sha256 ?? ""];
    case "result":
    case "error":
      return rows.flatMap((row) => [
        filterTextSlice(row.latestResult?.error),
        filterTextSlice(row.latestResult?.stderr),
        filterTextSlice(row.latestResult?.stdout),
      ]);
    case "exit":
    case "exit_code":
      return rows.map((row) => String(row.latestResult?.exit_code ?? ""));
    case "created":
    case "created_at":
      return [task.created_at ?? ""];
    case "started":
    case "started_at":
      return [task.started_at ?? ""];
    case "finished":
    case "finished_at":
      return [task.finished_at ?? ""];
    default:
      return [];
  }
}

function taskExpressionHaystack(task: TaskView, rows: NodeExecutionRow[]): string {
  return [
    task.id,
    shortId(task.id),
    task.actor_id,
    task.token_id,
    task.approval_id,
    task.interpreter,
    task.status,
    groupStatus(task, rows),
    task.script_sha256,
    task.created_at,
    task.started_at,
    task.finished_at,
    ...attemptTasks(task).flatMap((attempt) => [attempt.id, shortId(attempt.id), attempt.status]),
    ...task.targets,
    ...task.targets.map((id) => nodeName(id)),
    ...rows.flatMap((row) => [
      row.nodeId,
      row.node?.name,
      row.status,
      row.latestResult?.error,
      row.latestResult?.exit_code,
    ]),
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(" ");
}

function taskMatchesExpression(task: TaskView, rows: NodeExecutionRow[]): boolean {
  const expr = taskExpression.value.trim();
  if (!expr || taskExpressionError.value) return true;
  const result = evalFilterExpression(expr, (rawToken) => {
    const splitAt = rawToken.indexOf(":");
    if (splitAt > 0) {
      const values = taskExpressionFieldValues(task, rows, rawToken.slice(0, splitAt));
      const needle = rawToken.slice(splitAt + 1).trim();
      return values.length > 0 && values.some((value) => tokenMatchesText(value, needle));
    }
    return tokenMatchesText(taskExpressionHaystack(task, rows), rawToken);
  });
  return result.ok ? result.value : true;
}

const filteredRootTasks = computed(() => {
  const q = taskSearch.value.trim().toLowerCase();
  return rootTasks.value.filter((task) => {
    const rows = nodeRows(task);
    if (statusFilter.value !== "all" && groupStatus(task, rows) !== statusFilter.value) return false;
    if (!taskMatchesExpression(task, rows)) return false;
    if (!q) return true;
    const attemptIds = attemptTasks(task).map((attempt) => attempt.id);
    const haystack = [
      task.id,
      task.interpreter,
      groupStatus(task, rows),
      ...attemptIds,
      ...task.targets,
      ...task.targets.map((id) => nodeName(id)),
      ...rows.map((row) => row.latestResult?.error ?? ""),
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
});

const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const runningCount = computed(() => tasks.value.filter((task) => task.status === "leased").length);
const failedCount = computed(() => rootTasks.value.filter((task) => groupStatus(task, nodeRows(task)) === "failed").length);

/**
 * Mirror the status filter into the URL, and send the table back to its first
 * page because the row set underneath it just changed.
 *
 * Not immediate: on mount the URL is the source of truth, and a deep link that
 * carries both a status and a page must keep the page it was given rather than
 * have it stripped before the table has read it.
 */
watch(statusFilter, (status) => {
  const query = { ...route.query };
  delete query["tasks.page"];
  if (status !== "all") query.status = status;
  else delete query.status;
  router.replace({ query }).catch(() => {});
});

function nodeRegion(node: Node): string {
  return [node.geo?.country, node.geo?.region].filter(Boolean).join(" / ") || t("operations.tasks.unknownRegion");
}

function nodeName(id: string): string {
  return nodesById.value[id]?.name || id;
}

function timeValue(value?: string): number {
  return value ? new Date(value).getTime() || 0 : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toggleTarget(id: string) {
  const next = new Set(selectedTargets.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTargets.value = [...next];
}

function selectVisible(onlineOnly = false) {
  const next = new Set(selectedTargets.value);
  for (const node of filteredTargetNodes.value) {
    if (!onlineOnly || node.online) next.add(node.id);
  }
  selectedTargets.value = [...next];
}

function clearVisible() {
  const visible = new Set(filteredTargetNodes.value.map((node) => node.id));
  selectedTargets.value = selectedTargets.value.filter((id) => !visible.has(id));
}

function attemptTasks(root: TaskView): TaskView[] {
  return [root, ...(childTasksByRoot.value[root.id] ?? [])].sort((a, b) => timeValue(a.created_at) - timeValue(b.created_at));
}

function latestResultFor(taskId: string, nodeId: string): TaskResult | undefined {
  return (resultsByTask.value[taskId] ?? []).find((result) => result.node_id === nodeId);
}

function nodeRows(root: TaskView): NodeExecutionRow[] {
  const attempts = attemptTasks(root);
  const targets = unique(root.targets);
  return targets.map((nodeId) => {
    const nodeAttempts = attempts
      .filter((task) => task.targets.includes(nodeId))
      .map((task) => ({ task, result: latestResultFor(task.id, nodeId) }));
    const latest = nodeAttempts[nodeAttempts.length - 1];
    const latestResult = latest?.result;
    const latestTask = latest?.task;
    const failed = !!latestResult && resultFailed(latestResult);
    const status = latestResult
      ? failed
        ? "failed"
        : "finished"
      // The task was withdrawn before this target ever answered. Saying
      // "queued" here would promise a run that is no longer coming.
      : root.status === "expired"
        ? "expired"
      : latestTask?.status === "failed"
        ? "failed"
        : latestTask?.status === "cancelled"
          ? "cancelled"
          : latestTask?.status === "leased"
            ? "leased"
            : "queued";
    return {
      nodeId,
      node: nodesById.value[nodeId],
      attempts: nodeAttempts,
      latestTask,
      latestResult,
      status,
      failed: status === "failed",
    };
  });
}

/**
 * What is already true about the selected targets, before anything is queued.
 *
 * The picker states each node's condition on its own row - on/off, exec, root -
 * and that is enough when you are choosing three. It stops working at fleet
 * size: selecting 33 nodes means scrolling a list, and nobody tallies while
 * scrolling. The run this was built for went out to 33 targets, one of which
 * refused exec and one of which had been offline for a day, and neither was
 * noticed until the results came back.
 *
 * So this counts rather than re-states, and it advises rather than blocks.
 * Queueing for a node you know is coming back is legitimate - the queue is
 * store-and-forward by design - and a refusal here would only teach people to
 * route around it.
 */
interface TargetPreflight {
  offline: string[];
  execDisabled: string[];
  unprivileged: string[];
}

const targetPreflight = computed<TargetPreflight>(() => {
  const out: TargetPreflight = { offline: [], execDisabled: [], unprivileged: [] };
  for (const id of selectedTargets.value) {
    const node = nodesById.value[id];
    if (!node) continue;
    const name = node.name || id;
    if (node.disabled || !node.online) out.offline.push(name);
    const runtime = node.agent_runtime;
    if (!runtime?.reported_at) continue;
    if (runtime.no_exec || runtime.allow_exec === false) out.execDisabled.push(name);
    else if (runtime.task_sandbox_features?.includes("non-root-agent")) out.unprivileged.push(name);
  }
  return out;
});

/**
 * Name the first few and count the rest.
 *
 * The messages are written label-first and carry no count of their own, so they
 * read correctly for one node and for forty without needing plural forms. This
 * codebase has no pluralization convention and Chinese has no plural, so
 * introducing `|` message forms here would add one for no reader benefit.
 */
const PREFLIGHT_NAMES_SHOWN = 3;

function preflightNames(names: string[]): string {
  if (names.length <= PREFLIGHT_NAMES_SHOWN) return names.join(", ");
  const shown = names.slice(0, PREFLIGHT_NAMES_SHOWN).join(", ");
  return t("operations.tasks.preflight.andMore", {
    names: shown,
    count: names.length - PREFLIGHT_NAMES_SHOWN,
  });
}

const preflightNotes = computed(() => {
  const p = targetPreflight.value;
  const notes: { key: string; text: string; tone: "warning" | "muted" }[] = [];
  // Ordered by how badly each one wastes the operator's time: a refusal is a
  // guaranteed failed row, an offline node is an indefinite wait, and an
  // unprivileged agent is a result that looks fine and is not.
  if (p.execDisabled.length)
    notes.push({
      key: "exec",
      tone: "warning",
      text: t("operations.tasks.preflight.execDisabled", { names: preflightNames(p.execDisabled) }),
    });
  if (p.offline.length)
    notes.push({
      key: "offline",
      tone: "warning",
      text: t("operations.tasks.preflight.offline", { names: preflightNames(p.offline) }),
    });
  if (p.unprivileged.length)
    notes.push({
      key: "unpriv",
      tone: "muted",
      text: t("operations.tasks.preflight.unprivileged", { names: preflightNames(p.unprivileged) }),
    });
  return notes;
});

/**
 * Whether a target's agent could have measured anything privileged.
 *
 * A survey script that probes root-only state (`sshd -T` needs to read host
 * keys, `nft list table` needs CAP_NET_ADMIN) returns nothing at all on an
 * unprivileged agent. If that script swallows stderr - and shell scripts
 * written as `echo "k=$(cmd 2>/dev/null)"` almost always do - the node reports
 * empty fields and exit 0, which is indistinguishable from "measured, and the
 * answer is nothing". A whole fleet audit can be read off a wall of green
 * "Finished" rows that measured none of what it claims.
 *
 * The agent already reports this: SandboxProfile appends `non-root-agent` when
 * its euid is not 0, and warns "task scripts run as root" when it is. The fact
 * existed on the node record and was rendered on the node page, one click away
 * from the results it qualifies. This puts it next to the output.
 *
 * Caveat, and the reason this is not the whole fix: `agent_runtime` is the
 * agent's CURRENT state, not its state when the task ran. An agent restarted
 * with different flags since then will describe the wrong run. Pinning the
 * context onto TaskResult is what makes this audit-grade; this makes it useful
 * today, including for tasks that already ran.
 */
type ExecContext = { kind: "root" | "unprivileged" | "exec-disabled"; label: string; hint: string };

function execContext(node?: Node, result?: TaskResult): ExecContext | undefined {
  // Prefer what the server pinned when this result landed. The node's live
  // runtime is a fallback for results recorded before the pin existed, and it
  // describes the agent as it is now, which is not necessarily how it was.
  const pinned = result?.exec_context;
  const runtime = pinned
    ? {
        no_exec: pinned.exec_disabled,
        allow_exec: !pinned.exec_disabled,
        allow_root_exec: pinned.root_exec,
        task_sandbox_features: pinned.non_root ? ["non-root-agent"] : [],
        reported_at: pinned.reported_at ?? "pinned",
      }
    : node?.agent_runtime;
  if (!runtime || !runtime.reported_at) return undefined;
  if (runtime.no_exec || runtime.allow_exec === false) {
    return {
      kind: "exec-disabled",
      label: t("operations.tasks.execContext.disabled"),
      hint: t("operations.tasks.execContext.disabledHint"),
    };
  }
  if (runtime.task_sandbox_features?.includes("non-root-agent")) {
    return {
      kind: "unprivileged",
      label: t("operations.tasks.execContext.unprivileged"),
      hint: t("operations.tasks.execContext.unprivilegedHint"),
    };
  }
  if (runtime.allow_root_exec) {
    return {
      kind: "root",
      label: t("operations.tasks.execContext.root"),
      hint: t("operations.tasks.execContext.rootHint"),
    };
  }
  return undefined;
}

function execContextVariant(kind: ExecContext["kind"]): BadgeVariant {
  // Unprivileged is the one that silently invalidates results, so it is the one
  // that gets attention. Running as root is worth stating but is not a fault.
  return kind === "unprivileged" ? "destructive" : "outline";
}

function groupStatus(root: TaskView, rows: NodeExecutionRow[]): TaskView["status"] {
  // The server owns expiry: it is the side that withdrew delivery, and it knows
  // the deadline. Re-deriving "queued" from the rows here would contradict it.
  if (root.status === "expired") return "expired";
  if (rows.some((row) => row.status === "leased")) return "leased";
  if (rows.some((row) => row.status === "queued")) return root.status === "cancelled" ? "cancelled" : "queued";
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.length > 0 && rows.every((row) => row.status === "cancelled")) return "cancelled";
  return root.status === "cancelled" ? "cancelled" : "finished";
}

function resultFailed(result: TaskResult): boolean {
  return !!result.error || (result.exit_code ?? 0) !== 0;
}

function statusLabel(status: NodeRunStatus | TaskView["status"]): string {
  return t(`operations.tasks.status.${status}`);
}

function statusVariant(status: NodeRunStatus | TaskView["status"]): BadgeVariant {
  if (status === "failed") return "destructive";
  // Expired is not a failure and must not read like one: nothing went wrong,
  // the control plane stopped waiting. Secondary, the same weight as cancelled.
  if (status === "expired") return "secondary";
  if (status === "finished") return "default";
  if (status === "leased") return "secondary";
  return "outline";
}

function taskCounts(rows: NodeExecutionRow[]) {
  const done = rows.filter((row) => row.latestResult).length;
  const failed = rows.filter((row) => row.failed).length;
  return { done, failed, total: rows.length };
}

function nodeRowKey(taskId: string, nodeId: string): string {
  return `${taskId}:${nodeId}`;
}

function isNodeExpanded(taskId: string, nodeId: string): boolean {
  return expandedNodeRows.value.has(nodeRowKey(taskId, nodeId));
}

function toggleNodeExpanded(taskId: string, nodeId: string) {
  const key = nodeRowKey(taskId, nodeId);
  const next = new Set(expandedNodeRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedNodeRows.value = next;
}

/**
 * What to say about a target that has reported nothing.
 *
 * A resultless row can be queued, leased, failed or cancelled, and calling all
 * four of them "Running" told the operator a cancelled target was still working.
 * Each state gets its own sentence.
 */
function resultlessText(row: NodeExecutionRow): string {
  if (row.status === "queued") return t("operations.tasks.waitingLease");
  if (row.status === "leased") return t("operations.tasks.running");
  if (row.status === "cancelled") return t("operations.tasks.cancelledNoResult");
  return t("operations.tasks.failedNoResult");
}

function rowLatestText(row: NodeExecutionRow): string {
  if (!row.latestResult) return resultlessText(row);
  const exit = t("operations.tasks.exit", { code: row.latestResult.exit_code ?? 0 });
  const error = row.latestResult.error?.trim();
  return error ? `${exit} · ${error}` : `${exit} · ${formatDateTime(row.latestResult.finished_at)}`;
}

function taskLatestSummary(task: TaskView): string {
  const rows = nodeRows(task);
  const failed = rows.find((row) => row.failed);
  if (failed) return `${nodeName(failed.nodeId)} · ${rowLatestText(failed)}`;
  const active = rows.find((row) => row.status === "leased" || row.status === "queued");
  if (active) return `${nodeName(active.nodeId)} · ${rowLatestText(active)}`;
  const latest = [...rows]
    .filter((row) => row.latestResult)
    .sort((a, b) => timeValue(b.latestResult?.finished_at) - timeValue(a.latestResult?.finished_at))[0];
  return latest ? `${nodeName(latest.nodeId)} · ${rowLatestText(latest)}` : statusLabel(task.status);
}

function taskProgressLabel(task: TaskView): string {
  const counts = taskCounts(nodeRows(task));
  return t("operations.tasks.progressSummary", {
    done: counts.done,
    total: counts.total,
    failed: counts.failed,
    attempts: attemptTasks(task).length,
  });
}

/** Interpreter + script size, shared by the cell and its truncation title. */
function scriptMeta(task: TaskView): string {
  return `${task.interpreter} · ${t("operations.tasks.bytes", { count: task.script_size_bytes ?? 0 })}`;
}

/** Human-readable target list for the delete confirmation. */
const deleteTargetNames = computed(
  () => (deleteTarget.value?.targets ?? []).map((id) => nodeName(id)).join(", ") || t("common.misc.none"),
);

function nodeAgentBadges(node?: Node): string[] {
  return node ? agentConfigBadges(node) : [];
}

async function refreshAll() {
  await Promise.all([tasksQuery.refresh(), resultsQuery.refresh(), nodesQuery.refresh(), versionQuery.refresh()]);
}

async function createTask() {
  if (taskExecutionDisabled.value) {
    toast.error(t("operations.tasks.taskExecutionDisabled"));
    return;
  }
  if (!selectedTargets.value.length) {
    toast.error(t("operations.tasks.errNoTargets"));
    return;
  }
  if (!script.value.trim()) {
    toast.error(t("operations.tasks.errNoScript"));
    return;
  }
  creating.value = true;
  try {
    await api.tasks.create({
      targets: selectedTargets.value,
      capability: capability.value || undefined,
      interpreter: interpreter.value,
      script: script.value,
      timeout_sec: timeoutSec.value,
      output_limit: outputLimit.value,
    });
    toast.success(t("operations.tasks.toastQueued"));
    script.value = "";
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    creating.value = false;
  }
}

async function rerunTask(task: TaskView) {
  if (taskExecutionDisabled.value) {
    toast.error(t("operations.tasks.taskExecutionDisabled"));
    return;
  }
  actionPending.value = `task:${task.id}`;
  try {
    await api.tasks.rerun(task.id);
    toast.success(t("operations.tasks.toastRerun"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRerunFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function revealScript(task: TaskView) {
  if (revealedScripts.value[task.id]) {
    const next = { ...revealedScripts.value };
    delete next[task.id];
    revealedScripts.value = next;
    return;
  }
  if (revealingScriptID.value) return;
  revealingScriptID.value = task.id;
  try {
    const grant = await stepUp.request();
    const result = await api.tasks.revealScript(task.id, grant);
    revealedScripts.value = { ...revealedScripts.value, [task.id]: result.script };
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRevealScriptFailed"));
  } finally {
    revealingScriptID.value = "";
  }
}

async function rerunNode(task: TaskView, nodeId: string) {
  if (taskExecutionDisabled.value) {
    toast.error(t("operations.tasks.taskExecutionDisabled"));
    return;
  }
  actionPending.value = `node:${task.id}:${nodeId}`;
  try {
    await api.tasks.rerunNode(task.id, nodeId);
    toast.success(t("operations.tasks.toastRerunNode", { node: nodeName(nodeId) }));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRerunFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function cancelTask(task: TaskView) {
  actionPending.value = `task:${task.id}`;
  try {
    await api.tasks.cancel(task.id);
    toast.success(t("operations.tasks.toastCancelled"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastCancelFailed"));
  } finally {
    actionPending.value = null;
  }
}

function askDeleteTask(task: TaskView) {
  deleteTarget.value = task;
  deleteOpen.value = true;
}

async function confirmDeleteTask() {
  const task = deleteTarget.value;
  if (!task || actionPending.value === `task:${task.id}`) return;
  actionPending.value = `task:${task.id}`;
  try {
    await api.tasks.delete(task.id);
    toast.success(t("operations.tasks.toastDeleted"));
    deleteOpen.value = false;
    deleteTarget.value = undefined;
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastDeleteFailed"));
  } finally {
    actionPending.value = null;
  }
}

/**
 * Queue health. Failed is the only one that earns colour, and only when it is
 * not zero: a permanently red tile is a tile nobody reads.
 */
const taskMetrics = computed<Metric[]>(() => [
  { key: "queued", label: t("operations.tasks.queued"), value: queuedCount.value, icon: Timer },
  { key: "running", label: t("operations.tasks.running"), value: runningCount.value, icon: Terminal },
  {
    key: "failed",
    label: t("operations.tasks.failed"),
    value: failedCount.value,
    tone: failedCount.value > 0 ? "destructive" : "default",
    icon: XCircle,
  },
]);

</script>

<template>
  <div class="space-y-6 p-6">
    <PageHeader :title="$t('operations.tasks.title')" :description="$t('operations.tasks.description')">
      <template #status>
        <FreshnessLabel :last-updated="tasksQuery.lastUpdated.value || resultsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tasksQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', tasksQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- One band rather than three stretched cards. See MetricStrip. -->
    <MetricStrip :metrics="taskMetrics" :columns="3" />

    <Card v-if="!canRunTasks">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Lock class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('operations.tasks.queueTask') }}
        </CardTitle>
        <CardDescription>{{ $t('operations.tasks.requiresRunScope') }}</CardDescription>
      </CardHeader>
    </Card>

    <Card v-else>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Play class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('operations.tasks.queueTask') }}
        </CardTitle>
        <CardDescription>
          {{ taskExecutionDisabled ? $t('operations.tasks.taskExecutionDisabledHint') : $t('operations.tasks.queueTaskHint') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="taskExecutionDisabled" class="mb-4 flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <Ban class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{{ $t('operations.tasks.taskExecutionDisabled') }}</p>
        </div>
        <form class="grid gap-5 xl:grid-cols-[minmax(360px,0.9fr)_1fr]" @submit.prevent="createTask">
          <div class="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label>{{ $t('operations.tasks.targets') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('operations.tasks.selectedTargets', { count: selectedTargets.length }) }}
                </p>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="sm" @click="selectVisible(false)">
                  {{ $t('operations.tasks.selectVisible') }}
                </Button>
                <Button type="button" variant="outline" size="sm" @click="selectVisible(true)">
                  {{ $t('operations.tasks.selectOnline') }}
                </Button>
                <Button type="button" variant="ghost" size="sm" @click="clearVisible">
                  {{ $t('operations.tasks.clearVisible') }}
                </Button>
              </div>
            </div>

            <div class="grid gap-2 md:grid-cols-[1fr_0.8fr_0.8fr]">
              <div class="relative">
                <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input v-model="targetSearch" class="pl-8" :placeholder="$t('operations.tasks.targetSearch')" />
              </div>
              <Select v-model="targetTag">
                <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterTag')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('operations.tasks.allTags') }}</SelectItem>
                  <SelectItem v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</SelectItem>
                </SelectContent>
              </Select>
              <Select v-model="targetRegion">
                <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterRegion')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('operations.tasks.allRegions') }}</SelectItem>
                  <SelectItem v-for="region in allRegions" :key="region" :value="region">{{ region }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-1.5">
              <Label for="task-target-expr" class="text-xs text-muted-foreground">{{ $t('operations.tasks.targetExpression') }}</Label>
              <Input
                id="task-target-expr"
                v-model="targetExpr"
                class="font-mono text-xs"
                :placeholder="$t('operations.tasks.targetExpressionPlaceholder')"
              />
            </div>

            <DataState
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :has-data="nodesQuery.data.value !== undefined"
              :is-empty="filteredTargetNodes.length === 0"
              :empty-title="$t('operations.tasks.noNodesTitle')"
              :empty-description="$t('operations.tasks.noNodesDescription')"
              @retry="nodesQuery.refresh"
            >
              <div class="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
                <button
                  v-for="node in filteredTargetNodes"
                  :key="node.id"
                  type="button"
                  :class="cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-2.5 py-2 text-left transition-colors',
                    selectedSet.has(node.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                  )"
                  @click="toggleTarget(node.id)"
                >
                  <div class="grid min-w-0 gap-1">
                    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span class="truncate text-sm font-medium" :title="node.name || node.id">{{ node.name || node.id }}</span>
                      <Badge :variant="node.online ? 'default' : 'secondary'">
                        {{ node.online ? $t('operations.tasks.on') : $t('operations.tasks.off') }}
                      </Badge>
                      <Badge
                        v-for="badge in nodeAgentBadges(node).slice(0, 3)"
                        :key="`${node.id}:${badge}`"
                        variant="outline"
                        class="text-[10px]"
                      >
                        {{ badge }}
                      </Badge>
                    </div>
                    <div class="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span class="truncate font-mono" :title="node.id">{{ node.id }}</span>
                      <span aria-hidden="true">·</span>
                      <span class="truncate" :title="nodeRegion(node)">{{ nodeRegion(node) }}</span>
                    </div>
                    <div class="flex max-h-6 flex-wrap gap-1 overflow-hidden">
                      <Badge variant="outline" class="text-[10px]">{{ nodeRegion(node) }}</Badge>
                      <Badge v-for="tag in (node.tags ?? []).slice(0, 5)" :key="tag" variant="secondary" class="text-[10px]">{{ tag }}</Badge>
                      <Badge v-if="(node.tags ?? []).length > 5" variant="outline" class="text-[10px]">+{{ (node.tags ?? []).length - 5 }}</Badge>
                    </div>
                  </div>
                  <span
                    :class="cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                      selectedSet.has(node.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )"
                  >
                    <CheckCircle2 v-if="selectedSet.has(node.id)" class="size-3.5" aria-hidden="true" />
                  </span>
                </button>
              </div>
            </DataState>
          </div>

          <div class="space-y-3">
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.interpreter') }}</Label>
                <Select v-model="interpreter">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sh">sh</SelectItem>
                    <SelectItem value="bash">bash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.timeoutSec') }}</Label>
                <Input v-model.number="timeoutSec" type="number" min="1" max="600" />
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.outputLimit') }}</Label>
                <Input v-model.number="outputLimit" type="number" min="256" max="65536" />
              </div>
            </div>
            <!-- Optional, and only offered when there is something to confine to.
                 Narrows the targets; never widens them. -->
            <div v-if="declarableCapabilities.length" class="grid gap-1.5">
              <Label for="task-capability">{{ $t('operations.tasks.capability') }}</Label>
              <Select v-model="capability">
                <SelectTrigger id="task-capability">
                  <SelectValue :placeholder="$t('operations.tasks.capabilityNone')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{{ $t('operations.tasks.capabilityNone') }}</SelectItem>
                  <SelectItem
                    v-for="c in declarableCapabilities"
                    :key="c.capability"
                    :value="c.capability"
                  >
                    {{ c.capability }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-muted-foreground">
                {{ capability
                  ? $t('operations.tasks.capabilityHintOn', { capability })
                  : $t('operations.tasks.capabilityHint') }}
              </p>
            </div>

            <div class="grid gap-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Label>{{ $t('operations.tasks.script') }}</Label>
                <!-- The good shape as a starting point, not as enforcement.
                     See SURVEY_TEMPLATE for why this is a template rather than
                     an injected preamble. -->
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :disabled="!!script.trim()"
                  :title="$t('operations.tasks.surveyTemplateHint')"
                  @click="script = SURVEY_TEMPLATE"
                >
                  <ClipboardList class="size-3.5" aria-hidden="true" />
                  {{ $t('operations.tasks.surveyTemplate') }}
                </Button>
              </div>
              <textarea
                v-model="script"
                rows="12"
                class="rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                placeholder="uname -a"
              />
            </div>
            <!-- What is already known about the selection. Advisory, never a
                 block: see targetPreflight. -->
            <ul v-if="preflightNotes.length" class="grid gap-1">
              <li
                v-for="note in preflightNotes"
                :key="note.key"
                :class="cn(
                  'flex items-start gap-1.5 text-xs',
                  note.tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
                )"
              >
                <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ note.text }}</span>
              </li>
            </ul>

            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted-foreground">
                {{ $t('operations.tasks.fanoutHint') }}
              </p>
              <Button type="submit" :disabled="creating || taskExecutionDisabled || !selectedTargets.length || !script.trim()">
                <RefreshCw v-if="creating" class="size-4 animate-spin" aria-hidden="true" />
                <Play v-else class="size-4" aria-hidden="true" />
                {{ $t('operations.tasks.queueTaskCta') }}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{{ $t('operations.tasks.history') }}</CardTitle>
            <CardDescription>{{ $t('operations.tasks.historyHint') }}</CardDescription>
          </div>
          <div class="flex flex-wrap gap-2">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                v-model="taskSearch"
                class="w-72 pl-8"
                :placeholder="$t('operations.tasks.searchPlaceholder')"
                :aria-label="$t('operations.tasks.searchLabel')"
              />
            </div>
            <div class="relative">
              <Funnel class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                v-model="taskExpression"
                class="w-80 pl-8 font-mono text-xs"
                :class="taskExpressionError && 'border-destructive focus-visible:ring-destructive/20'"
                :placeholder="$t('operations.tasks.expressionPlaceholder')"
                :aria-label="$t('operations.tasks.expressionLabel')"
              />
            </div>
            <Select v-model="statusFilter">
              <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('operations.tasks.allStatuses') }}</SelectItem>
                <SelectItem value="queued">{{ $t('operations.tasks.status.queued') }}</SelectItem>
                <SelectItem value="leased">{{ $t('operations.tasks.status.leased') }}</SelectItem>
                <SelectItem value="finished">{{ $t('operations.tasks.status.finished') }}</SelectItem>
                <SelectItem value="failed">{{ $t('operations.tasks.status.failed') }}</SelectItem>
                <SelectItem value="cancelled">{{ $t('operations.tasks.status.cancelled') }}</SelectItem>
                <SelectItem value="expired">{{ $t('operations.tasks.status.expired') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p class="mt-2 text-xs" :class="taskExpressionError ? 'text-destructive' : 'text-muted-foreground'">
          {{ taskExpressionError || $t('operations.tasks.expressionHelp') }}
        </p>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tasksQuery.loading.value || resultsQuery.loading.value"
          :error="tasksQuery.error.value || resultsQuery.error.value"
          :has-data="tasksQuery.data.value !== undefined"
          :is-empty="filteredRootTasks.length === 0"
          :empty-title="rootTasks.length ? $t('operations.tasks.noMatch') : $t('operations.tasks.emptyTitle')"
          :empty-description="rootTasks.length ? $t('operations.tasks.noMatchDescription') : $t('operations.tasks.emptyDescription')"
          @retry="refreshAll"
        >
          <DataTable
            state-key="tasks"
            :columns="taskColumns"
            :rows="filteredRootTasks"
            :row-key="(row) => row.id"
            :page-size="25"
            :expression-filter="false"
            :empty-title="$t('operations.tasks.emptyTitle')"
            :empty-description="$t('operations.tasks.emptyDescription')"
            :no-match-title="$t('operations.tasks.noMatch')"
            :no-match-description="$t('operations.tasks.noMatchDescription')"
            @row-select="detailTaskId = $event.id"
          >
            <template #cell-status="{ row }">
              <Badge :variant="statusVariant(groupStatus(row, nodeRows(row)))">
                {{ statusLabel(groupStatus(row, nodeRows(row))) }}
              </Badge>
            </template>

            <template #cell-task="{ row }">
              <div class="min-w-0">
                <p class="truncate font-mono text-sm" :title="row.id">{{ shortId(row.id) }}</p>
                <p class="truncate text-xs text-muted-foreground" :title="scriptMeta(row)">
                  {{ scriptMeta(row) }}
                </p>
              </div>
            </template>

            <template #cell-targets="{ row }">
              <div class="flex flex-wrap items-center gap-1">
                <Badge
                  v-for="nodeId in row.targets.slice(0, 2)"
                  :key="nodeId"
                  variant="secondary"
                  class="max-w-40 truncate"
                  :title="nodeName(nodeId)"
                >
                  {{ nodeName(nodeId) }}
                </Badge>
                <Badge v-if="row.targets.length > 2" variant="outline">+{{ row.targets.length - 2 }}</Badge>
              </div>
            </template>

            <template #cell-progress="{ row }">
              <span class="font-mono text-sm tabular">
                {{ taskCounts(nodeRows(row)).done }} / {{ taskCounts(nodeRows(row)).total }}
              </span>
              <span v-if="taskCounts(nodeRows(row)).failed" class="ml-2 text-xs text-destructive tabular">
                {{ $t('operations.tasks.failedCount', { count: taskCounts(nodeRows(row)).failed }) }}
              </span>
            </template>

            <template #cell-created_at="{ row }">
              <span class="text-sm" :title="formatDateTime(row.created_at)">{{ formatRelativeTime(row.created_at) }}</span>
            </template>

            <template #cell-actions="{ row }">
              <div class="flex items-center justify-end gap-1">
                <Button variant="ghost" size="sm" @click="detailTaskId = row.id">
                  {{ $t('operations.tasks.openDetail') }}
                </Button>
              </div>
            </template>
          </DataTable>
        </DataState>
      </CardContent>
    </Card>

    <Dialog v-model:open="detailOpen">
      <DialogScrollContent class="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{{ $t('operations.tasks.detailTitle', { id: detailTask ? shortId(detailTask.id) : '' }) }}</DialogTitle>
          <DialogDescription>{{ $t('operations.tasks.detailDescription') }}</DialogDescription>
        </DialogHeader>
        <div v-if="detailTask">
              <div class="space-y-3 p-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge :variant="statusVariant(groupStatus(detailTask, nodeRows(detailTask)))">
                        {{ statusLabel(groupStatus(detailTask, nodeRows(detailTask))) }}
                      </Badge>
                      <span class="font-mono text-sm font-semibold">{{ shortId(detailTask.id) }}</span>
                      <Badge variant="outline">{{ detailTask.interpreter }}</Badge>
                      <span class="text-xs text-muted-foreground">{{ formatDateTime(detailTask.created_at) }}</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge
                        v-for="nodeId in detailTask.targets.slice(0, 4)"
                        :key="nodeId"
                        variant="secondary"
                        class="max-w-52 truncate"
                        :title="nodeName(nodeId)"
                      >
                        {{ nodeName(nodeId) }}
                      </Badge>
                      <Badge v-if="detailTask.targets.length > 4" variant="outline">
                        +{{ detailTask.targets.length - 4 }}
                      </Badge>
                    </div>
                    <p class="line-clamp-1 text-xs text-muted-foreground" :title="taskLatestSummary(detailTask)">
                      {{ taskLatestSummary(detailTask) }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="outline">
                      {{ $t('operations.tasks.bytes', { count: detailTask.script_size_bytes ?? 0 }) }}
                    </Badge>
                    <Badge variant="outline">
                      {{ $t('operations.tasks.seconds', { count: detailTask.timeout_sec ?? 0 }) }}
                    </Badge>
                    <Button variant="outline" size="sm" :disabled="revealingScriptID === detailTask.id" @click="revealScript(detailTask)">
                      <RefreshCw v-if="revealingScriptID === detailTask.id" class="size-4 animate-spin" aria-hidden="true" />
                      <KeyRound v-else class="size-4" aria-hidden="true" />
                      {{ revealedScripts[detailTask.id] ? $t('operations.tasks.hideScript') : $t('operations.tasks.revealScript') }}
                    </Button>
                    <Button variant="outline" size="sm" :disabled="taskExecutionDisabled || actionPending === `task:${detailTask.id}`" @click="rerunTask(detailTask)">
                      <RotateCcw class="size-4" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.rerun') }}
                    </Button>
                    <Button v-if="detailTask.status === 'queued'" variant="outline" size="sm" :disabled="actionPending === `task:${detailTask.id}`" @click="cancelTask(detailTask)">
                      <Ban class="size-4" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.cancel') }}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="text-destructive"
                      :disabled="actionPending === `task:${detailTask.id}`"
                      :aria-label="$t('operations.tasks.actions.delete')"
                      :title="$t('operations.tasks.actions.delete')"
                      @click="askDeleteTask(detailTask)"
                    >
                      <Trash2 class="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <div class="grid gap-2 text-sm md:grid-cols-4">
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.targetProgress') }}</p>
                    <p class="mt-1 font-medium">
                      {{ taskCounts(nodeRows(detailTask)).done }} / {{ taskCounts(nodeRows(detailTask)).total }}
                    </p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.failedTargets') }}</p>
                    <p class="mt-1 font-medium">{{ taskCounts(nodeRows(detailTask)).failed }}</p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.attempts') }}</p>
                    <p class="mt-1 font-medium">{{ attemptTasks(detailTask).length }}</p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.latest') }}</p>
                    <p class="mt-1 line-clamp-1 text-xs" :title="taskProgressLabel(detailTask)">{{ taskProgressLabel(detailTask) }}</p>
                  </div>
                </div>

                <div v-if="revealedScripts[detailTask.id]" class="rounded-md border border-border bg-muted/20 p-3">
                  <div class="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span class="inline-flex items-center gap-1">
                      <Lock class="size-3.5" aria-hidden="true" />
                      {{ $t('operations.tasks.scriptRevealed') }}
                    </span>
                    <span class="font-mono">{{ detailTask.script_sha256 }}</span>
                  </div>
                  <pre class="max-h-64 overflow-auto rounded bg-background/70 p-3 font-mono text-xs">{{ revealedScripts[detailTask.id] }}</pre>
                </div>

                <div  class="overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[760px] text-sm">
                    <thead class="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th scope="col" class="px-3 py-2 text-left">{{ $t('operations.tasks.colTarget') }}</th>
                        <th scope="col" class="px-3 py-2 text-left">{{ $t('operations.tasks.colStatus') }}</th>
                        <th scope="col" class="px-3 py-2 text-left">{{ $t('operations.tasks.colLatest') }}</th>
                        <th scope="col" class="px-3 py-2 text-left">{{ $t('operations.tasks.colAttempts') }}</th>
                        <th scope="col" class="px-3 py-2 text-right">{{ $t('operations.tasks.colActions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <template v-for="row in nodeRows(detailTask)" :key="row.nodeId">
                        <tr class="border-t border-border">
                          <td class="px-3 py-2">
                            <div class="min-w-0">
                              <p class="truncate font-medium" :title="nodeName(row.nodeId)">{{ nodeName(row.nodeId) }}</p>
                              <p class="truncate font-mono text-xs text-muted-foreground" :title="row.nodeId">{{ row.nodeId }}</p>
                              <!-- Could this agent have measured privileged state?
                                   See execContext: an unprivileged agent returns
                                   nothing for root-only probes, and a script that
                                   hides stderr reports that as exit 0. -->
                              <Badge
                                v-if="execContext(row.node, row.latestResult)"
                                :variant="execContextVariant(execContext(row.node, row.latestResult)!.kind)"
                                class="mt-1"
                                :title="execContext(row.node, row.latestResult)!.hint"
                              >
                                {{ execContext(row.node, row.latestResult)!.label }}
                              </Badge>
                            </div>
                          </td>
                          <td class="px-3 py-2">
                            <Badge :variant="statusVariant(row.status)">{{ statusLabel(row.status) }}</Badge>
                          </td>
                          <td class="px-3 py-2">
                            <p v-if="row.latestResult" class="font-mono text-xs">
                              {{ $t('operations.tasks.exit', { code: row.latestResult.exit_code ?? 0 }) }}
                              · {{ formatDateTime(row.latestResult.finished_at) }}
                            </p>
                            <p v-else class="text-xs text-muted-foreground">
                              {{ resultlessText(row) }}
                            </p>
                            <p v-if="row.latestResult?.error" class="mt-1 line-clamp-1 text-xs text-destructive" :title="row.latestResult.error">
                              {{ row.latestResult.error }}
                            </p>
                          </td>
                          <td class="px-3 py-2">
                            <Badge variant="outline">
                              <ListChecks class="size-3.5" aria-hidden="true" />
                              {{ row.attempts.length }}
                            </Badge>
                          </td>
                          <td class="px-3 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              @click="toggleNodeExpanded(detailTask.id, row.nodeId)"
                            >
                              <ChevronDown :class="cn('size-4 transition-transform', isNodeExpanded(detailTask.id, row.nodeId) && 'rotate-180')" aria-hidden="true" />
                              {{ isNodeExpanded(detailTask.id, row.nodeId) ? $t('operations.tasks.collapseAttempts') : $t('operations.tasks.expandAttempts') }}
                            </Button>
                            <Button
                              v-if="row.failed"
                              variant="outline"
                              size="sm"
                              :disabled="taskExecutionDisabled || actionPending === `node:${detailTask.id}:${row.nodeId}`"
                              @click="rerunNode(detailTask, row.nodeId)"
                            >
                              <RotateCcw class="size-4" aria-hidden="true" />
                              {{ $t('operations.tasks.actions.rerunNode') }}
                            </Button>
                          </td>
                        </tr>
                        <tr v-if="isNodeExpanded(detailTask.id, row.nodeId)" class="border-t border-border bg-muted/15">
                          <td colspan="5" class="px-3 py-3">
                            <div class="space-y-2">
                              <p class="text-sm font-medium">{{ nodeName(row.nodeId) }}</p>
                              <div
                                v-for="attempt in row.attempts"
                                :key="`${attempt.task.id}:${row.nodeId}`"
                                class="rounded-md border border-border bg-background p-3"
                              >
                                <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <Badge :variant="attempt.result ? statusVariant(resultFailed(attempt.result) ? 'failed' : 'finished') : statusVariant(attempt.task.status)">
                                    {{ attempt.result ? statusLabel(resultFailed(attempt.result) ? 'failed' : 'finished') : statusLabel(attempt.task.status) }}
                                  </Badge>
                                  <span class="font-mono">{{ shortId(attempt.task.id) }}</span>
                                  <span v-if="attempt.task.rerun_of_node_id">{{ $t('operations.tasks.nodeRerunBadge') }}</span>
                                  <span>{{ formatDateTime(attempt.result?.finished_at || attempt.task.created_at) }}</span>
                                </div>
                                <pre v-if="attempt.result?.stdout" class="max-h-56 overflow-auto rounded bg-muted p-3 text-xs">{{ attempt.result.stdout }}</pre>
                                <pre v-if="attempt.result?.stderr" class="mt-2 max-h-56 overflow-auto rounded bg-destructive/10 p-3 text-xs text-destructive">{{ attempt.result.stderr }}</pre>
                                <pre v-if="attempt.result?.error" class="mt-2 max-h-56 overflow-auto rounded bg-destructive/10 p-3 text-xs text-destructive">{{ attempt.result.error }}</pre>
                                <p v-if="!attempt.result" class="text-xs text-muted-foreground">{{ $t('operations.tasks.noResultYet') }}</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      </template>
                    </tbody>
                  </table>
                </div>
              </div>
        </div>
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('operations.tasks.deleteTitle')"
      :description="deleteTarget
        ? $t('operations.tasks.deleteDescription', { id: shortId(deleteTarget.id), targets: deleteTargetNames })
        : ''"
      :confirm-label="$t('operations.tasks.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!deleteTarget && actionPending === `task:${deleteTarget.id}`"
      @confirm="confirmDeleteTask"
    />

    <Dialog v-model:open="stepUpOpen">
      <DialogScrollContent class="sm:max-w-md" @escape-key-down.prevent="stepUp.cancel">
        <DialogHeader>
          <DialogTitle>{{ $t('operations.tasks.stepUpTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('operations.tasks.stepUpDescription') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="stepUp.submitTotp">
          <div class="grid gap-2">
            <Label for="task-step-up-code">{{ $t('operations.tasks.stepUpCode') }}</Label>
            <Input
              id="task-step-up-code"
              v-model="stepUpCode"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              placeholder="123456"
            />
            <p v-if="stepUpError" class="text-xs text-destructive">{{ stepUpError }}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="stepUp.cancel">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="button" variant="outline" :disabled="!!stepUpPending || !stepUp.supportsPasskey" @click="stepUp.submitPasskey">
              <RefreshCw v-if="stepUpPending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
              <KeyRound v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.stepUpPasskey') }}
            </Button>
            <Button type="submit" :disabled="!!stepUpPending || !stepUpCode.trim()">
              <RefreshCw v-if="stepUpPending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
              <Lock v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.stepUpSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
