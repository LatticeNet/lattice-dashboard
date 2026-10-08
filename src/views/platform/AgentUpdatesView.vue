<script setup lang="ts">
/**
 * Agent Updates (design 23, section 4.5): which node runs which agent, who
 * is behind, and rolling them forward.
 *
 * What a node runs is `Node.agent_version`, its own report; the head counts
 * nodes current and behind against the latest stable release, and the
 * version bar replaces the four equal tiles. One row per node, so the node
 * with no policy is listed (and named in attention) instead of invisible. A
 * row opens the node's policy in the sheet on `?open=`. "Plan behind nodes"
 * files one plan per behind node with a policy, after a confirm that names
 * each one and the ones it cannot plan. The release card and the binaries the
 * control plane serves itself move to a Distribution layer on `?view=`.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { toast } from "@/lib/toast";
import {
  AlertTriangle,
  BookOpen,
  DownloadCloud,
  ExternalLink,
  FileCode2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  isAgentUpdateNoopError,
  isStaleAgentUpdateApprovalView,
  type AgentArtifactListing,
  type AgentArtifactView,
  type AgentUpdatePolicy,
  type AgentUpdatePolicyUpsertRequest,
  type AgentReleaseCandidate,
  type AgentReleaseInfo,
  type ApprovalView,
} from "@/lib/api";
import { agentUpdateStaleParams } from "@/views/operations/approvalsListModel";
import { useAsyncData } from "@/composables/useAsyncData";
import { useLayer } from "@/composables/useLayer";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindQueryParam } from "@/composables/useQueryParam";
import { useListQuery, useQueryText } from "@/composables/useListQuery";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { proofReason } from "@/components/common/proofModel";
import {
  agentStanding,
  bulkButtonState,
  bulkPlan,
  fleetCells,
  tableErrorSource,
  normalizeAgentVersion,
  versionDistribution,
  type AgentStanding,
} from "./agentUpdatesModel";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ListQueryBar from "@/components/common/ListQueryBar.vue";
import { AGENT_UPDATES_QUERY_EXAMPLES, agentUpdatesQuerySchema } from "./agentUpdatesQuery";
import { withoutSorts } from "@/lib/query/syntax";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const TARGET_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DEFAULT_INSTALL_PATH = "/opt/lattice/node-agent/lattice-agent";
const DEFAULT_SERVICE_NAME = "lattice-agent.service";
const AGENT_UPDATES_GUIDE_URL = "https://latticenet.github.io/security/agent-updates";

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("node:admin"));
const canPlan = computed(() => auth.can("node:admin") && auth.can("network:plan"));

const policiesQuery = useAsyncData(
  (signal) => api.agentUpdates.list({ signal }).then((r) => unwrap(r, "policies")),
  { pollInterval: 15000 },
);
const releaseQuery = useAsyncData<AgentReleaseInfo>((signal) => api.agentUpdates.releases({ signal }));
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});
const approvalsQuery = useAsyncData(
  // This plugin's rows only, no plan text: the page prints the agent updates
  // whose plan has gone stale, and it reads status, reason and the stale flag
  // to find them, never a plan. Staleness cannot be asked for by status (see
  // agentUpdateStaleParams), so it stays a client-side filter as before.
  (signal) => (canPlan.value ? api.approvals.list(agentUpdateStaleParams(), { signal }).then((r) => unwrap(r, "approvals")) : Promise.resolve([] as ApprovalView[])),
  { pollInterval: 15000 },
);

const policies = computed(() => policiesQuery.data.value ?? []);
const releaseInfo = computed(() => releaseQuery.data.value);
const releaseCandidates = computed(() => releaseInfo.value?.candidates ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const approvals = computed(() => approvalsQuery.data.value ?? []);
const staleAgentUpdateApprovals = computed(() =>
  approvals.value.filter(isStaleAgentUpdateApprovalView).sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || "")),
);
const staleApprovalsByNode = computed(() => {
  const byNode = new Map<string, ApprovalView[]>();
  for (const approval of staleAgentUpdateApprovals.value) {
    const list = byNode.get(approval.node_id) ?? [];
    list.push(approval);
    byNode.set(approval.node_id, list);
  }
  return byNode;
});

// ── Control-plane distribution ───────────────────────────────────────────────
// What the control plane holds and can serve to nodes itself. A node's upgrade
// depends on this rather than on its own egress to the release host, which is
// what stranded slow and badly-resolving nodes before.
const AGENT_ARCHES = ["amd64", "arm64"] as const;

const artifactsQuery = useAsyncData<AgentArtifactListing>((signal) => api.agentUpdates.artifacts({ signal }), {
  pollInterval: 30000,
});
const artifacts = computed(() => artifactsQuery.data.value?.artifacts ?? []);
// A stored binary nodes cannot be pointed at is not the same as one they can.
// Only say so once there is something stored, so an untouched install does not
// carry a warning about a feature it is not using.
const distributionDisabled = computed(
  () => artifactsQuery.data.value?.serving_enabled === false && artifacts.value.length > 0,
);
const artifactStorageLabel = computed(() =>
  t("platform.agentUpdates.distributionStorage", {
    used: formatBytes(artifactsQuery.data.value?.stored_bytes ?? 0),
    limit: formatBytes(artifactsQuery.data.value?.limit_bytes ?? 0),
  }),
);

const importVersion = ref("");
const importArches = ref<string[]>(["amd64"]);
const importing = ref(false);

function toggleImportArch(arch: string, on: boolean): void {
  const next = new Set(importArches.value);
  if (on) next.add(arch);
  else next.delete(arch);
  importArches.value = [...next];
}

// Each architecture is its own import, and each is reported on its own. A run
// where one architecture failed is never rendered as a success.
async function runImport(): Promise<void> {
  if (importing.value || !importArches.value.length) return;
  const version = importVersion.value.trim() || "latest";
  importing.value = true;
  let failed = 0;
  try {
    for (const arch of importArches.value) {
      try {
        const stored = await api.agentUpdates.importArtifact({ version, os: "linux", arch });
        toast.success(
          t("platform.agentUpdates.importDone", { version: stored.version, arch: stored.arch }),
        );
      } catch (error) {
        failed += 1;
        toast.error(
          t("platform.agentUpdates.importFailed", {
            arch,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  } finally {
    importing.value = false;
    artifactsQuery.refresh();
    if (!failed) policiesQuery.refresh();
  }
}

const artifactDeleteTarget = ref<AgentArtifactView | undefined>();
const deletingArtifact = ref(false);

async function confirmArtifactDelete(): Promise<void> {
  const target = artifactDeleteTarget.value;
  if (!target) return;
  deletingArtifact.value = true;
  try {
    await api.agentUpdates.deleteArtifact({
      version: target.version,
      os: target.os,
      arch: target.arch,
    });
    toast.success(
      t("platform.agentUpdates.deleteArtifactDone", { version: target.version, arch: target.arch }),
    );
    artifactDeleteTarget.value = undefined;
    artifactsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.deleteFailed"));
  } finally {
    deletingArtifact.value = false;
  }
}

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || id;
}

function staleApprovalCount(nodeId: string): number {
  return staleApprovalsByNode.value.get(nodeId)?.length ?? 0;
}

const artifactColumns = computed<DataTableColumn<AgentArtifactView>[]>(() => [
  { key: "version", label: t("platform.agentUpdates.artifactColVersion"), sortable: true },
  { key: "platform", label: t("platform.agentUpdates.artifactColPlatform"), value: (artifact) => `${artifact.os}/${artifact.arch}` },
  { key: "sha256", label: t("platform.agentUpdates.artifactColDigest") },
  { key: "size", label: t("platform.agentUpdates.artifactColSize"), sortable: true, value: (artifact) => artifact.size_bytes },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

// ── Create / edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const editing = ref(false);

const form = ref({
  node_id: "",
  enabled: true,
  auto_plan: false,
  target_version: "latest",
  binary_url: "",
  sha256: "",
  install_path: "",
  service_name: "",
});

function resetForm(): void {
  form.value = {
    node_id: "",
    enabled: true,
    auto_plan: false,
    target_version: "latest",
    binary_url: "",
    sha256: "",
    install_path: "",
    service_name: "",
  };
}

function openCreate(): void {
  if (!canAdmin.value) return;
  editing.value = false;
  resetForm();
  formOpen.value = true;
}

function openEdit(policy: AgentUpdatePolicy): void {
  if (!canAdmin.value) return;
  editing.value = true;
  form.value = {
    node_id: policy.node_id,
    enabled: policy.enabled,
    auto_plan: policy.auto_plan,
    target_version: policy.target_version,
    binary_url: policy.binary_url,
    sha256: policy.sha256,
    install_path: policy.install_path === DEFAULT_INSTALL_PATH ? "" : policy.install_path,
    service_name: policy.service_name === DEFAULT_SERVICE_NAME ? "" : policy.service_name,
  };
  formOpen.value = true;
}

const versionValid = computed(
  () => !!form.value.target_version.trim() && TARGET_VERSION_RE.test(form.value.target_version.trim()),
);
const customArtifactMode = computed(() => !!form.value.binary_url.trim() || !!form.value.sha256.trim());

function isSecretFreeAgentBinaryURL(raw: string): boolean {
  const url = raw.trim();
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !url.includes("?") &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

const urlValid = computed(() => {
  const url = form.value.binary_url.trim();
  if (!url) return !customArtifactMode.value;
  return isSecretFreeAgentBinaryURL(url);
});
const shaValid = computed(() => {
  const sha = form.value.sha256.trim();
  if (!sha) return !customArtifactMode.value;
  return SHA256_RE.test(sha);
});
const artifactPinsValid = computed(() => {
  const hasURL = !!form.value.binary_url.trim();
  const hasSHA = !!form.value.sha256.trim();
  if (!hasURL && !hasSHA) return true;
  if (hasURL !== hasSHA) return false;
  return urlValid.value && shaValid.value;
});

const canSubmit = computed(
  () =>
    !!form.value.node_id &&
    !!form.value.target_version.trim() &&
    versionValid.value &&
    artifactPinsValid.value,
);

function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function releaseChannelLabel(channel: string): string {
  const key = channel === "stable" || channel === "alpha" || channel === "beta" || channel === "rc" ? channel : "prerelease";
  return t(`platform.agentUpdates.channels.${key}`);
}

const prereleaseCandidates = computed(() => releaseCandidates.value.filter((candidate) => candidate.prerelease));

const releaseOptions = computed(() => {
  const options: Array<{ value: string; label: string; channel: string; prerelease: boolean; latest: boolean }> = [];
  const latest = releaseInfo.value?.latest_version;
  options.push({
    value: "latest",
    label: latest
      ? t("platform.agentUpdates.stableLatestOption", { version: latest })
      : t("platform.agentUpdates.stableLatestOptionUnknown"),
    channel: "stable",
    prerelease: false,
    latest: true,
  });
  const seen = new Set(["latest"]);
  for (const candidate of releaseCandidates.value) {
    const value = normalizeReleaseVersion(candidate.version);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: `${releaseChannelLabel(candidate.channel)} ${value}${candidate.latest_for_channel ? ` · ${t("platform.agentUpdates.latestForChannel")}` : ""}`,
      channel: candidate.channel,
      prerelease: candidate.prerelease,
      latest: candidate.latest_for_channel,
    });
  }
  return options.slice(0, 16);
});

const releaseOptionValue = computed(() => {
  const target = form.value.target_version.trim();
  if (!target || target.toLowerCase() === "latest") return "latest";
  const normalized = normalizeReleaseVersion(target);
  return releaseOptions.value.some((option) => option.value === normalized) ? normalized : "custom";
});

const selectedReleaseCandidate = computed<AgentReleaseCandidate | undefined>(() => {
  const normalized = normalizeReleaseVersion(form.value.target_version);
  return releaseCandidates.value.find((candidate) => normalizeReleaseVersion(candidate.version) === normalized);
});

const selectedTargetIsPrerelease = computed(() => {
  if (selectedReleaseCandidate.value) return selectedReleaseCandidate.value.prerelease;
  return /(?:^|[._+-])(alpha|beta|rc|pre|preview|dev|nightly)(?:[._+-]|$)/i.test(normalizeReleaseVersion(form.value.target_version));
});

function applyReleaseOption(value: unknown): void {
  if (value === null || value === undefined) return;
  const next = String(value);
  if (next === "custom") return;
  form.value.target_version = next;
}

const targetSuggestions = computed(() => {
  const latest = releaseInfo.value?.latest_version;
  const values = ["latest"];
  if (latest) values.push(latest, `v${latest}`);
  for (const candidate of releaseCandidates.value) {
    if (candidate.version && !values.includes(candidate.version)) values.push(candidate.version);
    if (candidate.tag_name && !values.includes(candidate.tag_name)) values.push(candidate.tag_name);
  }
  for (const policy of policies.value) {
    if (policy.target_version && !values.includes(policy.target_version)) values.push(policy.target_version);
    if (policy.last_applied_version && !values.includes(policy.last_applied_version)) values.push(policy.last_applied_version);
  }
  return values.slice(0, 18);
});

function targetLabel(policy: AgentUpdatePolicy): string {
  const target = policy.target_version || "latest";
  if (target.toLowerCase() === "latest" && releaseInfo.value?.latest_version) {
    return t("platform.agentUpdates.stableLatestTarget", { version: releaseInfo.value.latest_version });
  }
  return target;
}

function releaseFetchedLabel(): string {
  return releaseInfo.value?.fetched_at
    ? t("platform.agentUpdates.fetchedAt", { time: formatDateTime(releaseInfo.value.fetched_at) })
    : t("platform.agentUpdates.fetchedNever");
}

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: AgentUpdatePolicyUpsertRequest = {
      node_id: form.value.node_id,
      enabled: form.value.enabled,
      auto_plan: form.value.auto_plan,
      target_version: form.value.target_version.trim(),
    };
    if (form.value.binary_url.trim() || form.value.sha256.trim()) {
      req.binary_url = form.value.binary_url.trim();
      req.sha256 = form.value.sha256.trim();
    }
    if (form.value.install_path.trim()) req.install_path = form.value.install_path.trim();
    if (form.value.service_name.trim()) req.service_name = form.value.service_name.trim();
    await api.agentUpdates.upsert(req);
    toast.success(editing.value ? t("platform.agentUpdates.policyUpdated") : t("platform.agentUpdates.policyCreated"));
    formOpen.value = false;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<AgentUpdatePolicy | undefined>();
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.agentUpdates.delete(deleteTarget.value.node_id);
    toast.success(t("platform.agentUpdates.policyDeleted"));
    deleteTarget.value = undefined;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan → approval ──────────────────────────────────────────────────────────
const planOpen = ref(false);
const planning = ref<string | undefined>();
const approval = ref<ApprovalView | undefined>();
const planDigest = ref("");
// SECURITY-CRITICAL: digestHex hashes sha256Hex(input || ""), byte-for-byte
// identical to the prior `sha256Hex(result.plan || "")` binding. Bytes unchanged.
const { digestHex } = usePlanDigest();

// Noop (409) state: offer a forced re-plan.
const noopOpen = ref(false);
const noopNodeId = ref<string | undefined>();
const noopMessage = ref("");

async function runPlan(nodeId: string, force: boolean): Promise<void> {
  if (!canPlan.value) return;
  planning.value = nodeId;
  try {
    const result = await api.agentUpdates.plan(nodeId, force || undefined);
    approval.value = result;
    planDigest.value = await digestHex(result.plan);
    noopOpen.value = false;
    planOpen.value = true;
    toast.success(t("platform.agentUpdates.planCreated"));
    policiesQuery.refresh();
  } catch (error) {
    // Noop = node already at target. Offer a forced re-plan.
    if (isAgentUpdateNoopError(error) && !force) {
      noopNodeId.value = nodeId;
      noopMessage.value = error.message || t("platform.agentUpdates.nodeAlreadyTarget");
      noopOpen.value = true;
    } else {
      toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.planFailed"));
    }
  } finally {
    planning.value = undefined;
  }
}

function forcePlan(): void {
  if (noopNodeId.value) void runPlan(noopNodeId.value, true);
}

// Deep-link: /platform/agent-updates?node=<id> opens the policy editor for that
// node once the data loads (e.g. from a node's "Agent-updates" cross-link). An
// existing policy opens in edit mode; otherwise a pre-filled create. Seeds at
// most once per id, admins only (editing requires node:admin).
const seededPolicyNode = ref<string | undefined>(undefined);
watch(
  [policies, nodes, () => route.query.node],
  ([pols, nds, nodeQ]) => {
    const id = typeof nodeQ === "string" ? nodeQ : undefined;
    if (!id || id === seededPolicyNode.value || !canAdmin.value) return;
    if (nds.length === 0) return; // wait until the node Select has options
    seededPolicyNode.value = id;
    const existing = pols.find((p) => p.node_id === id);
    if (existing) {
      openEdit(existing);
    } else {
      openCreate();
      form.value.node_id = id;
    }
  },
  { immediate: true },
);
/* ------------------------------------------------------------------ */
/* One row per node (design 23, section 4.5)                           */
/* ------------------------------------------------------------------ */

provideNodeDirectory(computed(() => nodesQuery.data.value));

const LAYERS = ["nodes", "distribution"] as const;
type Layer = (typeof LAYERS)[number];
const layer = useLayer<Layer>(() => LAYERS, () => "nodes");

const latest = computed(() => releaseInfo.value?.latest_version);
const policyByNode = computed(() => new Map(policies.value.map((policy) => [policy.node_id, policy])));

interface FleetRow {
  nodeId: string;
  name: string;
  version?: string;
  standing: AgentStanding;
  policy?: AgentUpdatePolicy;
}

/**
 * Every node the console can read, with its policy when it has one, and every
 * policy whose node is not in the list (a node gone from the fleet still has
 * a policy that can be deleted).
 */
const fleetRows = computed<FleetRow[]>(() => {
  const rows: FleetRow[] = nodes.value.map((node) => ({
    nodeId: node.id,
    name: node.name || node.id,
    version: node.agent_version,
    standing: agentStanding(node.agent_version, latest.value),
    policy: policyByNode.value.get(node.id),
  }));
  const listed = new Set(rows.map((row) => row.nodeId));
  for (const policy of policies.value) {
    if (!listed.has(policy.node_id)) rows.push({ nodeId: policy.node_id, name: policy.node_id, standing: "unknown", policy });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
});

/*
 * The query field (src/lib/query) over the fleet table: the shared node
 * fields plus standing, policy, target and when the policy last planned. It
 * lives at ?q=; the table's own search box lived at ?nodes.q=, and an old
 * link that carries one is read once into the field.
 */
const owned = useOwnedRoute();
{
  const current = owned.query();
  const legacy = current["nodes.q"];
  if (typeof legacy === "string" && legacy.trim() && current.q === undefined) {
    const { ["nodes.q"]: _moved, ...rest } = current;
    owned.replace({ ...rest, q: legacy });
  }
}
const storedQuery = bindQueryParam<string>(owned, "q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const nodesById = computed(() => new Map(nodes.value.map((node) => [node.id, node] as const)));
const querySchema = agentUpdatesQuerySchema<FleetRow>({
  nodeOf: (row) => nodesById.value.get(row.nodeId),
  target: (row) => (row.policy ? targetLabel(row.policy) : ""),
  staleApprovals: (row) => staleApprovalCount(row.nodeId),
});
const queryText = useQueryText(storedQuery);
const query = useListQuery(fleetRows, querySchema, queryText);
const queryExamples = computed(() =>
  AGENT_UPDATES_QUERY_EXAMPLES.map((example) => ({ query: example.query, note: t(`platform.agentUpdatesPage.query.examples.${example.key}`) })),
);

const standingCounts = computed(() => {
  const out: Record<AgentStanding, number> = { current: 0, behind: 0, ahead: 0, unknown: 0 };
  for (const row of fleetRows.value) if (nodes.value.some((node) => node.id === row.nodeId)) out[row.standing] += 1;
  return out;
});

const slices = computed(() => versionDistribution(nodes.value.map((node) => node.agent_version), latest.value));
const sliceTotal = computed(() => slices.value.reduce((sum, slice) => sum + slice.count, 0));

/** Whether each read has landed at least once. A cell whose source never did says "not read". */
const nodesRead = computed(() => nodesQuery.data.value !== undefined);
const policiesRead = computed(() => policiesQuery.data.value !== undefined);

// The node list is the page's subject; the policies and the release are
// named in their own segment when they fail, so one failed read never wipes
// the counts the other reads hold.
const proof = useProof(nodesQuery);

const proofSegments = computed<ProofSegment[]>(() => {
  const parts: ProofSegment[] = [];
  if (latest.value) {
    parts.push({ key: "latest", text: t("platform.agentUpdatesPage.proof.latest", { version: latest.value }), tone: "strong" });
    if (releaseInfo.value?.fetched_at) {
      parts.push({ key: "checked", text: t("platform.agentUpdatesPage.proof.checked", { age: formatRelativeTime(releaseInfo.value.fetched_at) }) });
    }
  } else if (releaseQuery.error.value) {
    parts.push({ key: "latest", text: t("platform.agentUpdatesPage.proof.latestUnread", { reason: proofReason(releaseQuery.error.value) }), tone: "warning" });
  }
  if (!policiesRead.value && policiesQuery.error.value) {
    parts.push({ key: "policies", text: t("platform.agentUpdatesPage.proof.policiesUnread", { reason: proofReason(policiesQuery.error.value) }), tone: "warning" });
  }
  if (nodesQuery.data.value !== undefined) {
    const n = nodes.value.length;
    parts.push({ key: "nodes", text: t("platform.agentUpdatesPage.proof.nodes", { n }, n) });
    if (latest.value) {
      const c = standingCounts.value;
      parts.push({ key: "current", text: t("platform.agentUpdatesPage.proof.current", { n: c.current }) });
      if (c.behind) parts.push({ key: "behind", text: t("platform.agentUpdatesPage.proof.behind", { n: c.behind }), tone: "warning" });
      if (c.ahead) parts.push({ key: "ahead", text: t("platform.agentUpdatesPage.proof.ahead", { n: c.ahead }) });
    }
  }
  return parts;
});

function refreshAll(): void {
  void policiesQuery.refresh();
  void nodesQuery.refresh();
  void releaseQuery.refresh();
  if (canPlan.value) void approvalsQuery.refresh();
  void artifactsQuery.refresh();
}

const sheet = useRouteOpen();

function addPolicyFor(nodeId: string): void {
  openCreate();
  form.value.node_id = nodeId;
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const row of fleetRows.value) {
    if (row.policy?.last_error) {
      items.push({
        key: `error:${row.nodeId}`,
        tone: "danger",
        claim: t("platform.agentUpdatesPage.attention.errorClaim", { node: row.name }),
        proof: row.policy.last_error.split("\n")[0],
        action: { label: t("platform.agentUpdatesPage.attention.open"), run: () => sheet.open(row.nodeId) },
      });
    }
  }
  if (staleAgentUpdateApprovals.value.length) {
    items.push({
      key: "stale",
      tone: "warning",
      claim: t("platform.agentUpdates.staleApprovalSummary", { count: staleAgentUpdateApprovals.value.length }),
      proof: t("platform.agentUpdates.staleApprovalSummaryHint"),
      action: { label: t("platform.agentUpdates.openApprovals"), to: "/approvals" },
    });
  }
  if (policiesQuery.data.value !== undefined) {
    for (const row of fleetRows.value) {
      if (row.policy) continue;
      items.push({
        key: `nopolicy:${row.nodeId}`,
        tone: "warning",
        claim: t("platform.agentUpdatesPage.attention.noPolicyClaim", { node: row.name }),
        proof: row.version
          ? t("platform.agentUpdatesPage.attention.noPolicyRuns", { version: normalizeAgentVersion(row.version) })
          : t("platform.agentUpdatesPage.attention.noPolicyUnknown"),
        action: canAdmin.value ? { label: t("platform.agentUpdatesPage.attention.addPolicy"), run: () => addPolicyFor(row.nodeId) } : undefined,
      });
    }
  }
  return items;
});

const layerTabs = computed<LayerTab<Layer>[]>(() => [
  { value: "nodes", label: t("platform.agentUpdatesPage.layers.nodes"), count: nodesQuery.data.value !== undefined ? nodes.value.length : undefined },
  { value: "distribution", label: t("platform.agentUpdatesPage.layers.distribution"), count: artifactsQuery.data.value !== undefined ? artifacts.value.length : undefined },
]);

const STANDING_TONE: Record<AgentStanding, string> = {
  current: "text-muted-foreground",
  behind: "text-warning-text",
  ahead: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** The version bar's fill: the latest release in the accent, older ones amber, unknown hatched grey. */
const SLICE_FILL: Record<AgentStanding, string> = {
  current: "bg-primary",
  behind: "bg-warning",
  ahead: "bg-muted-foreground/60",
  unknown: "bg-muted",
};

const columns = computed<DataTableColumn<FleetRow>[]>(() => [
  { key: "name", label: t("platform.agentUpdates.colNode"), sortable: true, searchable: true },
  { key: "version", label: t("platform.agentUpdatesPage.colRuns"), sortable: true, searchable: true, value: (row) => normalizeAgentVersion(row.version) },
  { key: "target", label: t("platform.agentUpdates.colTarget"), sortable: true, value: (row) => (row.policy ? targetLabel(row.policy) : "") },
  { key: "policy", label: t("platform.agentUpdatesPage.colPolicy"), sortable: true, value: (row) => (row.policy ? (row.policy.enabled ? 2 : 1) + (row.policy.auto_plan ? 1 : 0) : 0) },
  { key: "last_planned", label: t("platform.agentUpdates.colLastPlanned"), sortable: true, value: (row) => row.policy?.last_planned_at ?? "" },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

function policyText(policy: AgentUpdatePolicy): string {
  if (!policy.enabled) return t("common.status.disabled");
  return policy.auto_plan ? t("platform.agentUpdates.autoPlan") : t("platform.agentUpdates.manual");
}

function menuFor(row: FleetRow): RowMenuItem[] {
  if (!row.policy) {
    return [
      {
        key: "add",
        label: t("platform.agentUpdatesPage.attention.addPolicy"),
        icon: Plus,
        hidden: !canAdmin.value,
        disabled: !policiesRead.value,
        reason: policiesRead.value ? undefined : t("platform.agentUpdatesPage.policiesUnreadReason"),
        run: () => addPolicyFor(row.nodeId),
      },
    ];
  }
  const policy = row.policy;
  return [
    { key: "plan", label: t("platform.agentUpdates.plan"), icon: Play, hidden: !canPlan.value, disabled: planning.value === row.nodeId, run: () => void runPlan(row.nodeId, false) },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(policy) },
    { key: "delete", label: t("platform.agentUpdatesPage.deletePolicy"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = policy) },
  ];
}

const openRow = computed(() => fleetRows.value.find((row) => row.nodeId === sheet.openId.value));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openRow.value) return proof.value.state === "stale" ? ("stale" as const) : ("ready" as const);
  if (nodesQuery.data.value === undefined && policiesQuery.data.value === undefined) return proof.value.state === "failed" ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

/* ------------------------------------------------------------------ */
/* Plan behind nodes: one plan per behind node, after a confirm        */
/* ------------------------------------------------------------------ */

const bulk = computed(() => bulkPlan(fleetRows.value, latest.value));

/**
 * Why the head button cannot plan, naming the read that failed. While any of
 * its three inputs is unread the button carries no count: a zero there would
 * be a claim about the fleet nobody read.
 */
const reads = computed(() => ({ nodesRead: nodesRead.value, policiesRead: policiesRead.value, latest: latest.value }));
const bulkButton = computed(() => bulkButtonState(reads.value, bulk.value.plan.length));
const bulkReason = computed(() => (bulkButton.value.block ? t(`platform.agentUpdatesPage.bulk.${bulkButton.value.block}`) : undefined));

/**
 * The table's error banner says "showing the last data", so it speaks only
 * for a read that once succeeded. A read that never landed shows as "not
 * read" in its cells and in the proof line instead.
 */
const tableError = computed<Error | null>(() => {
  const source = tableErrorSource({
    nodesRead: nodesRead.value,
    nodesFailed: !!nodesQuery.error.value,
    policiesRead: policiesRead.value,
    policiesFailed: !!policiesQuery.error.value,
  });
  return source === "nodes" ? (nodesQuery.error.value ?? null) : source === "policies" ? (policiesQuery.error.value ?? null) : null;
});

/** What each cell of a row may say, given which reads landed (agentUpdatesModel.fleetCells). */
function cellsOf(row: FleetRow) {
  return fleetCells(row, reads.value);
}
const bulkOpen = ref(false);
const bulkRunning = ref(false);

function rowName(nodeId: string): string {
  return fleetRows.value.find((row) => row.nodeId === nodeId)?.name ?? nodeId;
}

/** The version a policy's plan would install: "latest" resolves to the release read. */
function resolvedTarget(policy: AgentUpdatePolicy): string {
  const target = policy.target_version || "latest";
  if (target.toLowerCase() === "latest") return latest.value ? normalizeAgentVersion(latest.value) : target;
  return normalizeAgentVersion(target);
}

const bulkLines = computed(() =>
  bulk.value.plan.map((row) => t("platform.agentUpdatesPage.bulk.line", { node: rowName(row.nodeId), from: normalizeAgentVersion(row.version), to: resolvedTarget(row.policy) })),
);
const bulkSkipped = computed(() =>
  bulk.value.skipped.map((row) => t("platform.agentUpdatesPage.bulk.skipped", { node: rowName(row.nodeId), from: normalizeAgentVersion(row.version) })),
);

/**
 * Files the plans one node at a time and reports each: a node already at its
 * policy's target answers 409 and is named as such, never counted as planned.
 */
async function runBulkPlan(): Promise<void> {
  if (!canPlan.value || bulkRunning.value) return;
  bulkRunning.value = true;
  const planned: string[] = [];
  const noop: string[] = [];
  const failed: string[] = [];
  try {
    for (const row of bulk.value.plan) {
      try {
        await api.agentUpdates.plan(row.nodeId);
        planned.push(rowName(row.nodeId));
      } catch (error) {
        if (isAgentUpdateNoopError(error)) noop.push(rowName(row.nodeId));
        else failed.push(`${rowName(row.nodeId)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    bulkOpen.value = false;
    const summary = t("platform.agentUpdatesPage.bulk.done", { planned: planned.length, noop: noop.length, failed: failed.length });
    if (failed.length) toast.error(summary, { description: failed.join("\n") });
    else toast.success(summary, { description: noop.length ? t("platform.agentUpdatesPage.bulk.noopNames", { names: noop.join(", ") }) : undefined });
    void policiesQuery.refresh();
    if (canPlan.value) void approvalsQuery.refresh();
  } finally {
    bulkRunning.value = false;
  }
}

const deleteImpact = computed(() => {
  const policy = deleteTarget.value;
  if (!policy) return [];
  return [
    t("platform.agentUpdatesPage.deleteImpactAgent", { node: nodeName(policy.node_id) }),
    t("platform.agentUpdatesPage.deleteImpactFuture"),
  ];
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.agentUpdates.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.agentUpdates.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="ghost" size="sm" as-child>
          <a :href="AGENT_UPDATES_GUIDE_URL" target="_blank" rel="noreferrer">
            <BookOpen aria-hidden="true" class="size-4" />
            {{ $t('common.actions.docs') }}
          </a>
        </Button>
        <Button variant="outline" size="sm" :disabled="policiesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw aria-hidden="true" :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canPlan"
          size="sm"
          :disabled="bulkButton.disabled"
          :title="bulkReason"
          data-testid="plan-behind"
          @click="bulkOpen = true"
        >
          <Play aria-hidden="true" class="size-4" />
          {{ bulkButton.counted ? $t('platform.agentUpdatesPage.bulk.button', { n: bulk.plan.length }) : $t('platform.agentUpdatesPage.bulk.buttonUncounted') }}
        </Button>
      </template>
    </PageHeader>

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('platform.agentUpdatesPage.layersLabel')" />

    <template v-if="layer === 'nodes'">
      <AttentionList :items="attention" />

      <!-- The version bar: what the fleet runs, the latest release in the accent. -->
      <section v-if="slices.length" class="space-y-2" aria-labelledby="agent-versions-heading">
        <h2 id="agent-versions-heading" class="text-sm font-medium">{{ $t('platform.agentUpdatesPage.versions') }}</h2>
        <div class="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" :aria-label="slices.map((slice) => `${slice.version || $t('platform.agentUpdatesPage.noVersion')}: ${slice.count}`).join(', ')" data-testid="version-bar">
          <div
            v-for="slice in slices"
            :key="slice.version || 'none'"
            :class="cn('h-full border-r border-background last:border-r-0', SLICE_FILL[slice.standing])"
            :style="{ width: `${(slice.count / sliceTotal) * 100}%` }"
          />
        </div>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <li v-for="slice in slices" :key="slice.version || 'none'" class="flex items-center gap-1.5">
            <span aria-hidden="true" :class="cn('size-2 rounded-full', SLICE_FILL[slice.standing])" />
            <span class="font-mono">{{ slice.version || $t('platform.agentUpdatesPage.noVersion') }}</span>
            <span class="font-mono tabular-nums text-muted-foreground">{{ slice.count }}</span>
            <span v-if="slice.standing === 'current'" class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.latestMark') }}</span>
          </li>
        </ul>
      </section>

      <ListQueryBar
        v-if="fleetRows.length || queryText"
        v-model="queryText"
        class="max-w-3xl"
        storage-key="agent-updates"
        testid="agent-updates-query"
        :query="query"
        :count="query.filtering.value ? { shown: query.rows.value.length, total: fleetRows.length } : undefined"
        :label="$t('platform.agentUpdatesPage.query.label')"
        :placeholder="$t('platform.agentUpdatesPage.query.placeholder')"
        :examples="queryExamples"
      />

      <DataTable
        state-key="nodes"
        :columns="columns"
        :rows="query.rows.value"
        :row-key="(row) => row.nodeId"
        :loading="nodesQuery.loading.value && policiesQuery.loading.value"
        :error="tableError"
        :has-data="nodesRead || policiesRead"
        :page-size="50"
        :expression-filter="false"
        :external-sort="query.sorted.value"
        :class="query.invalid.value && 'opacity-50'"
        :inert="query.invalid.value || undefined"
        :row-click="(row, el) => sheet.open(row.nodeId, el)"
        :active-row-id="sheet.openId.value"
        :show-summary="false"
        :empty-title="query.filtering.value && fleetRows.length ? $t('platform.shared.noMatchesTitle') : $t('platform.agentUpdates.emptyTitle')"
        :empty-description="query.filtering.value && fleetRows.length ? $t('platform.shared.noMatchesDescription') : $t('platform.agentUpdates.emptyDescription')"
        :no-match-title="$t('platform.shared.noMatchesTitle')"
        :no-match-description="$t('platform.shared.noMatchesDescription')"
        @retry="refreshAll"
        @sort="queryText = withoutSorts(queryText)"
      >
        <template #cell-name="{ row }">
          <span v-if="nodesRead" class="font-medium">{{ row.name }}</span>
          <NodeLabel v-else :id="row.nodeId" class="text-xs" />
        </template>
        <template #cell-version="{ row }">
          <span v-if="cellsOf(row).runs === 'notRead'" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.notRead') }}</span>
          <span v-else :class="cn('whitespace-nowrap font-mono text-xs', STANDING_TONE[row.standing])">{{ cellsOf(row).runs === 'version' ? normalizeAgentVersion(row.version) : $t('platform.agentUpdatesPage.noVersion') }}</span>
          <span v-if="row.standing === 'behind'" class="block text-xs text-warning-text">{{ $t('platform.agentUpdatesPage.standing.behind') }}</span>
        </template>
        <template #cell-target="{ row }">
          <span v-if="row.policy" class="whitespace-nowrap font-mono text-xs">{{ targetLabel(row.policy) }}</span>
          <span v-else-if="cellsOf(row).target === 'notRead'" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.notRead') }}</span>
          <span v-else class="text-xs text-warning-text">{{ $t('platform.agentUpdatesPage.noPolicy') }}</span>
        </template>
        <template #cell-policy="{ row }">
          <span v-if="row.policy" class="whitespace-nowrap text-xs text-muted-foreground">{{ policyText(row.policy) }}</span>
          <span v-else-if="cellsOf(row).policy === 'notRead'" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.notRead') }}</span>
          <span v-else class="text-xs text-muted-foreground">-</span>
          <span v-if="row.policy?.last_error" class="block text-xs text-destructive">{{ $t('platform.agentUpdatesPage.policyFailed') }}</span>
          <span v-if="staleApprovalCount(row.nodeId)" class="block text-xs text-warning-text">{{ $t('platform.agentUpdates.staleApprovalBadge', { count: staleApprovalCount(row.nodeId) }) }}</span>
        </template>
        <template #cell-last_planned="{ row }">
          <span class="whitespace-nowrap text-xs text-muted-foreground" :title="row.policy?.last_planned_at ? formatDateTime(row.policy.last_planned_at) : undefined">
            {{ cellsOf(row).lastPlanned === 'time' ? formatRelativeTime(row.policy!.last_planned_at!) : cellsOf(row).lastPlanned === 'never' ? $t('common.misc.never') : $t('platform.agentUpdatesPage.notRead') }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu v-if="canAdmin || canPlan" :name="row.name" :items="menuFor(row)" />
        </template>
      </DataTable>
    </template>

    <!-- Distribution: the release the control plane follows, and the binaries it serves itself. -->
    <template v-else>
      <section class="space-y-2" aria-labelledby="agent-release-heading">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="agent-release-heading" class="text-sm font-medium">{{ $t('platform.agentUpdates.releaseTitle') }}</h2>
          <a v-if="releaseInfo?.release_url" :href="releaseInfo.release_url" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            {{ $t('platform.agentUpdates.openRelease') }}
            <ExternalLink class="size-3" aria-hidden="true" />
          </a>
        </div>
        <p v-if="releaseQuery.error.value" class="text-sm text-warning-text">{{ proofReason(releaseQuery.error.value) }}</p>
        <dl v-else class="grid grid-cols-1 gap-x-6 gap-y-2 rounded-md border border-border px-3 py-2.5 text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.latestVersion') }}</dt>
            <dd class="font-mono">{{ releaseInfo?.latest_version || $t('platform.agentUpdates.latestUnknown') }} <span class="text-xs text-muted-foreground">{{ releaseInfo?.latest_tag }}</span></dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.releaseRepo') }}</dt>
            <dd class="truncate font-mono text-xs">{{ releaseInfo?.repo || 'LatticeNet/lattice-node-agent' }}</dd>
            <dd class="text-xs text-muted-foreground">{{ releaseFetchedLabel() }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.releaseArtifacts') }}</dt>
            <dd class="font-mono tabular-nums">{{ releaseInfo?.artifacts?.length ?? 0 }}</dd>
          </div>
        </dl>
        <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.integrityHint') }}</p>
        <div v-if="prereleaseCandidates.length" class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-muted-foreground">{{ $t('platform.agentUpdates.releaseCandidates') }}</span>
          <a
            v-for="candidate in prereleaseCandidates.slice(0, 6)"
            :key="candidate.tag_name"
            :href="candidate.release_url"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <span>{{ releaseChannelLabel(candidate.channel) }}</span>
            <span>{{ candidate.version }}</span>
            <span v-if="candidate.latest_for_channel" class="text-primary">{{ $t('platform.agentUpdates.latestForChannel') }}</span>
          </a>
        </div>
      </section>

      <section class="space-y-3" aria-labelledby="agent-distribution-heading">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="agent-distribution-heading" class="text-sm font-medium">{{ $t('platform.agentUpdates.distributionTitle') }}</h2>
          <span class="font-mono text-xs text-muted-foreground">{{ artifactStorageLabel }}</span>
        </div>
        <p class="max-w-3xl text-xs text-muted-foreground">{{ $t('platform.agentUpdates.distributionHint') }}</p>
        <p v-if="artifactsQuery.error.value" class="text-sm text-warning-text">{{ proofReason(artifactsQuery.error.value) }}</p>
        <p v-if="distributionDisabled" class="flex items-start gap-2 text-sm text-warning-text">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{{ $t('platform.agentUpdates.distributionDisabled') }}</span>
        </p>
        <div v-if="!artifacts.length && !artifactsQuery.error.value" class="rounded-md border border-dashed border-border p-4">
          <p class="text-sm font-medium">{{ $t('platform.agentUpdates.distributionEmptyTitle') }}</p>
          <p class="mt-1 text-sm text-muted-foreground">{{ $t('platform.agentUpdates.distributionEmptyDescription') }}</p>
        </div>
        <DataTable
          v-else-if="artifacts.length"
          :columns="artifactColumns"
          :rows="artifacts"
          :row-key="(artifact) => `${artifact.version}/${artifact.os}/${artifact.arch}`"
          :expression-filter="false"
          :show-summary="false"
        >
          <template #cell-version="{ row }">
            <span class="font-mono text-xs font-medium">{{ row.version }}</span>
          </template>
          <template #cell-platform="{ row }">
            <span class="font-mono text-xs text-muted-foreground">{{ row.os }}/{{ row.arch }}</span>
          </template>
          <template #cell-sha256="{ row }">
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-xs text-muted-foreground">{{ row.sha256.slice(0, 16) }}</span>
              <CopyButton :value="row.sha256" />
            </div>
          </template>
          <template #cell-size="{ row }">
            <span class="tabular text-xs">{{ formatBytes(row.size_bytes) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu
              v-if="canAdmin"
              :name="`${row.version} ${row.os}/${row.arch}`"
              :items="[{ key: 'delete', label: $t('common.actions.delete'), icon: Trash2, danger: true, run: () => (artifactDeleteTarget = row) }]"
            />
          </template>
        </DataTable>

        <div v-if="canAdmin" class="space-y-3 rounded-md border border-border p-3">
          <div>
            <p class="text-sm font-medium">{{ $t('platform.agentUpdates.importTitle') }}</p>
            <p class="mt-1 max-w-3xl text-xs text-muted-foreground">{{ $t('platform.agentUpdates.importHint') }}</p>
          </div>
          <div class="flex flex-wrap items-end gap-4">
            <div class="grid gap-1.5">
              <Label for="agent-artifact-version">{{ $t('platform.agentUpdates.importVersionLabel') }}</Label>
              <Input id="agent-artifact-version" v-model="importVersion" class="w-56 font-mono" :placeholder="$t('platform.agentUpdates.importVersionPlaceholder')" />
            </div>
            <fieldset class="grid gap-1.5">
              <legend class="text-sm font-medium">{{ $t('platform.agentUpdates.importArchLabel') }}</legend>
              <div class="flex items-center gap-4 pt-1">
                <label v-for="arch in AGENT_ARCHES" :key="arch" class="flex items-center gap-2 text-sm">
                  <Checkbox :model-value="importArches.includes(arch)" @update:model-value="(v) => toggleImportArch(arch, v === true)" />
                  <span class="font-mono">{{ arch }}</span>
                </label>
              </div>
            </fieldset>
            <Button variant="outline" :disabled="importing || !importArches.length" @click="runImport">
              <RefreshCw v-if="importing" aria-hidden="true" class="size-4 animate-spin" />
              <DownloadCloud v-else aria-hidden="true" class="size-4" />
              {{ importing ? $t('platform.agentUpdates.importing') : $t('platform.agentUpdates.importAction') }}
            </Button>
          </div>
        </div>
      </section>
    </template>

    <!-- One node's policy, in the sheet on ?open=<node id>. -->
    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openRow ? openRow.name : (sheet.openId.value ?? '')"
      :subtitle="openRow?.version ? $t('platform.agentUpdatesPage.sheet.runs', { version: normalizeAgentVersion(openRow.version) }) : undefined"
      :mono-subtitle="false"
      :state="sheetState"
      :error="proof.error"
      :page-to="openRow ? { name: 'node-detail', params: { id: openRow.nodeId } } : undefined"
      :read-only="!canAdmin && !canPlan"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('platform.agentUpdatesPage.sheet.goneTitle')"
      :gone-description="$t('platform.agentUpdatesPage.sheet.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openRow" class="space-y-4 text-sm">
        <p :class="STANDING_TONE[openRow.standing] === 'text-muted-foreground' ? 'text-foreground' : STANDING_TONE[openRow.standing]">
          {{ $t(`platform.agentUpdatesPage.standing.${openRow.standing}`, { latest: latest ?? '' }) }}
        </p>
        <template v-if="openRow.policy">
          <pre
            v-if="openRow.policy.last_error"
            class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-foreground"
          >{{ openRow.policy.last_error }}</pre>
          <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.colTarget') }}</dt>
              <dd class="font-mono text-xs">{{ targetLabel(openRow.policy) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.colPolicy') }}</dt>
              <dd>{{ policyText(openRow.policy) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.colLastPlanned') }}</dt>
              <dd class="text-xs">
                {{ openRow.policy.last_planned_at ? formatDateTime(openRow.policy.last_planned_at) : $t('common.misc.never') }}
                <span v-if="openRow.policy.last_planned_version" class="font-mono text-muted-foreground">· {{ openRow.policy.last_planned_version }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.colApplied') }}</dt>
              <dd class="text-xs">
                <span v-if="openRow.policy.last_applied_version" class="font-mono">{{ openRow.policy.last_applied_version }}</span>
                <span v-else class="text-muted-foreground">{{ $t('platform.agentUpdates.appliedUnconfirmed') }}</span>
              </dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.colBinaryUrl') }}</dt>
              <dd v-if="openRow.policy.binary_url" class="flex items-start gap-1">
                <code class="min-w-0 break-all font-mono text-xs">{{ openRow.policy.binary_url }}</code>
                <CopyButton :value="openRow.policy.binary_url" />
              </dd>
              <dd v-else class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.officialRelease') }}</dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.colSha256') }}</dt>
              <dd v-if="openRow.policy.sha256" class="flex items-start gap-1">
                <code class="min-w-0 break-all font-mono text-xs">{{ openRow.policy.sha256 }}</code>
                <CopyButton :value="openRow.policy.sha256" />
              </dd>
              <dd v-else class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.resolvedInPlan') }}</dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.sheet.install') }}</dt>
              <dd class="break-all font-mono text-xs">{{ openRow.policy.install_path || DEFAULT_INSTALL_PATH }} · {{ openRow.policy.service_name || DEFAULT_SERVICE_NAME }}</dd>
            </div>
          </dl>
          <p v-if="staleApprovalCount(openRow.nodeId)" class="text-xs text-warning-text">
            {{ $t('platform.agentUpdates.staleApprovalBadge', { count: staleApprovalCount(openRow.nodeId) }) }}
            <RouterLink to="/approvals" class="text-primary underline-offset-4 hover:underline">{{ $t('platform.agentUpdates.openApprovals') }}</RouterLink>
          </p>
        </template>
        <p v-else-if="!policiesRead" class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.sheet.policiesUnread') }}</p>
        <p v-else class="text-warning-text">{{ $t('platform.agentUpdatesPage.sheet.noPolicy') }}</p>
      </div>
      <template v-if="openRow" #actions>
        <template v-if="openRow.policy">
          <Button v-if="canPlan" variant="outline" size="sm" type="button" :disabled="planning === openRow.nodeId" @click="runPlan(openRow.nodeId, false)">
            <RefreshCw v-if="planning === openRow.nodeId" class="animate-spin" aria-hidden="true" />
            <Play v-else aria-hidden="true" />
            {{ $t('platform.agentUpdates.plan') }}
          </Button>
          <Button v-if="canAdmin" variant="outline" size="sm" type="button" @click="openEdit(openRow.policy)">
            <Pencil aria-hidden="true" />
            {{ $t('common.actions.edit') }}
          </Button>
          <RowMenu v-if="canAdmin" :name="openRow.name" :items="menuFor(openRow).filter((item) => item.key === 'delete')" />
        </template>
        <Button v-else-if="canAdmin && policiesRead" variant="outline" size="sm" type="button" @click="addPolicyFor(openRow.nodeId)">
          <Plus aria-hidden="true" />
          {{ $t('platform.agentUpdatesPage.attention.addPolicy') }}
        </Button>
      </template>
    </ObjectSheet>

    <!-- Plan behind nodes: one plan per node, after a confirm that names them. -->
    <ConfirmDialog
      :open="bulkOpen"
      variant="default"
      :title="$t('platform.agentUpdatesPage.bulk.title', { n: bulk.plan.length }, bulk.plan.length)"
      :description="$t('platform.agentUpdatesPage.bulk.description')"
      :confirm-label="$t('platform.agentUpdatesPage.bulk.confirm', { n: bulk.plan.length })"
      :cancel-label="$t('common.actions.cancel')"
      :pending="bulkRunning"
      @update:open="(v) => { bulkOpen = v; }"
      @confirm="runBulkPlan"
    >
      <div class="space-y-3 text-sm" data-testid="bulk-plan-list">
        <div class="space-y-1">
          <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.agentUpdatesPage.bulk.impactTitle') }}</p>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="line in bulkLines" :key="line" class="px-3 py-1.5 font-mono text-xs">{{ line }}</li>
          </ul>
        </div>
        <div v-if="bulkSkipped.length" class="space-y-1">
          <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.agentUpdatesPage.bulk.skippedTitle') }}</p>
          <ul class="space-y-0.5 text-xs text-warning-text">
            <li v-for="line in bulkSkipped" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>
    </ConfirmDialog>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t('platform.agentUpdates.editPolicyTitle') : $t('platform.agentUpdates.newPolicyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.agentUpdates.formHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid grid-cols-1 min-w-0 gap-3 lg:grid-cols-3">
            <div class="grid gap-2">
              <Label for="pol-node">{{ $t('platform.agentUpdates.nodeLabel') }}</Label>
              <Select v-model="form.node_id" :disabled="editing">
                <SelectTrigger id="pol-node">
                  <SelectValue :placeholder="$t('platform.agentUpdates.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="editing" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.nodeImmutable') }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="pol-release-choice">{{ $t('platform.agentUpdates.releaseChoiceLabel') }}</Label>
              <Select :model-value="releaseOptionValue" @update:model-value="applyReleaseOption">
                <SelectTrigger id="pol-release-choice">
                  <SelectValue :placeholder="$t('platform.agentUpdates.releaseChoicePlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in releaseOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </SelectItem>
                  <SelectItem value="custom">{{ $t('platform.agentUpdates.customVersionOption') }}</SelectItem>
                </SelectContent>
              </Select>
              <p v-if="selectedTargetIsPrerelease" class="text-xs text-warning">
                {{ $t('platform.agentUpdates.prereleaseTargetWarning') }}
              </p>
              <p v-else class="text-xs text-muted-foreground">
                {{ $t('platform.agentUpdates.releaseChoiceHint') }}
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="pol-version">{{ $t('platform.agentUpdates.targetVersionLabel') }}</Label>
              <Input
                id="pol-version"
                v-model="form.target_version"
                list="agent-update-version-suggestions"
                required
                :placeholder="$t('platform.agentUpdates.targetVersionPlaceholder')"
                :class="cn(form.target_version && !versionValid && 'border-destructive')"
              />
              <datalist id="agent-update-version-suggestions">
                <option v-for="version in targetSuggestions" :key="version" :value="version" />
              </datalist>
              <p v-if="form.target_version && !versionValid" class="text-xs text-destructive">
                {{ $t('platform.agentUpdates.versionInvalid') }}
              </p>
              <p v-else class="text-xs text-muted-foreground">
                {{ $t('platform.agentUpdates.versionHint', { latest: releaseInfo?.latest_version || $t('platform.agentUpdates.latestUnknown') }) }}
              </p>
            </div>
          </div>

          <div class="rounded-md border border-border bg-muted/20 p-3">
            <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium">{{ $t('platform.agentUpdates.artifactMode') }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ customArtifactMode ? $t('platform.agentUpdates.customArtifactHint') : $t('platform.agentUpdates.officialArtifactHint') }}
                </p>
              </div>
              <Badge :variant="customArtifactMode ? 'warning' : 'success'">
                {{ customArtifactMode ? $t('platform.agentUpdates.customArtifact') : $t('platform.agentUpdates.officialRelease') }}
              </Badge>
            </div>

            <div class="grid gap-3">
              <div class="grid gap-2">
                <Label for="pol-url">{{ $t('platform.agentUpdates.binaryUrlLabel') }}</Label>
                <Input
                  id="pol-url"
                  v-model="form.binary_url"
                  placeholder="https://releases.example.com/lattice-agent-1.4.2"
                  :class="cn(form.binary_url && !urlValid && 'border-destructive')"
                />
                <p v-if="form.binary_url && !urlValid" class="text-xs text-destructive">
                  {{ $t('platform.agentUpdates.urlInvalid') }}
                </p>
              </div>

              <div class="grid gap-2">
                <Label for="pol-sha">{{ $t('platform.agentUpdates.sha256Label') }}</Label>
                <Input
                  id="pol-sha"
                  v-model="form.sha256"
                  :placeholder="$t('platform.agentUpdates.sha256Placeholder')"
                  :class="cn('font-mono', form.sha256 && !shaValid && 'border-destructive')"
                />
                <p v-if="form.sha256 && !shaValid" class="text-xs text-destructive">
                  {{ $t('platform.agentUpdates.sha256Invalid') }}
                </p>
                <p v-if="customArtifactMode && !artifactPinsValid" class="text-xs text-destructive">
                  {{ $t('platform.agentUpdates.artifactPinsInvalid') }}
                </p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="pol-install">{{ $t('platform.agentUpdates.installPathLabel') }}</Label>
              <Input id="pol-install" v-model="form.install_path" :placeholder="DEFAULT_INSTALL_PATH" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.installPathHint', { path: DEFAULT_INSTALL_PATH }) }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="pol-service">{{ $t('platform.agentUpdates.serviceNameLabel') }}</Label>
              <Input id="pol-service" v-model="form.service_name" :placeholder="DEFAULT_SERVICE_NAME" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.serviceNameHint', { name: DEFAULT_SERVICE_NAME }) }}</p>
            </div>
          </div>

          <div class="flex flex-wrap gap-6">
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox v-model="form.enabled" />
              <span>{{ $t('platform.agentUpdates.enabledLabel') }}</span>
            </label>
            <div class="grid gap-1">
              <label class="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox v-model="form.auto_plan" />
                <span>{{ $t('platform.agentUpdates.autoPlanLabel') }}</span>
              </label>
              <p :class="cn('text-xs', form.auto_plan ? 'text-warning' : 'text-muted-foreground')">
                {{ $t('platform.agentUpdates.autoPlanWarning') }}
              </p>
            </div>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Plus v-else-if="!editing" aria-hidden="true" class="size-4" />
              <Pencil v-else aria-hidden="true" class="size-4" />
              {{ editing ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete: irreversible inside Lattice (design 23, 3.8); the node keeps its agent. -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('platform.agentUpdates.deletePolicyTitle')"
      :description="$t('platform.agentUpdates.deletePolicyConfirm', { node: deleteTarget ? nodeName(deleteTarget.node_id) : '' })"
      :impact="deleteImpact"
      :impact-title="$t('platform.agentUpdatesPage.deleteImpactTitle')"
      :confirm-label="$t('platform.agentUpdatesPage.deletePolicy')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <ConfirmDialog
      :open="!!artifactDeleteTarget"
      :title="$t('platform.agentUpdates.deleteArtifactTitle')"
      :description="$t('platform.agentUpdates.deleteArtifactBody', {
        version: artifactDeleteTarget?.version ?? '',
        arch: artifactDeleteTarget?.arch ?? '',
      })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletingArtifact"
      @update:open="(v) => { if (!v) artifactDeleteTarget = undefined; }"
      @confirm="confirmArtifactDelete"
    />

    <!-- Noop (409): offer force plan -->
    <Dialog v-model:open="noopOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.agentUpdates.noopTitle') }}</DialogTitle>
          <DialogDescription>{{ noopMessage }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ $t('platform.agentUpdates.noopHint') }}
        </p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button
            type="button"
            :disabled="!!noopNodeId && planning === noopNodeId"
            @click="forcePlan"
          >
            <RefreshCw v-if="!!noopNodeId && planning === noopNodeId" aria-hidden="true" class="size-4 animate-spin" />
            <FileCode2 v-else aria-hidden="true" class="size-4" />
            {{ $t('platform.agentUpdates.forcePlan') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Plan dialog (creates a pending Approval) -->
    <!--
      SECURITY-CRITICAL: PlanReviewDialog is a pure renderer. `:plan-text` is the
      exact bytes (approval.plan) and `:digest` is planDigest, computed via
      usePlanDigest().digestHex(result.plan) === sha256Hex(result.plan || "").
      The displayed digest derives from the same bytes shown in the plan body.
    -->
    <PlanReviewDialog
      v-model:open="planOpen"
      :plan-text="approval?.plan"
      :digest="planDigest"
      :title="$t('platform.agentUpdates.planTitle')"
      :description="approval ? $t('platform.agentUpdates.planReviewOn', { plugin: approval.plugin, action: approval.action, node: nodeName(approval.node_id) }) : ''"
      :plan-label="$t('platform.agentUpdates.plan')"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t('platform.agentUpdates.goToApprovals')"
      approvals-to="/approvals"
    >
      <template #badges>
        <Badge v-if="approval" variant="outline">{{ $t('platform.agentUpdates.approvalLabel', { id: shortId(approval.id, 12) }) }}</Badge>
        <Badge v-if="approval" variant="warning">{{ approval.status }}</Badge>
        <span v-if="approval?.created_at" class="text-xs text-muted-foreground">{{ formatDateTime(approval.created_at) }}</span>
      </template>

      <div class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
        {{ $t('platform.agentUpdates.planCreatedReview') }}
        <span class="font-medium text-foreground">{{ $t('platform.agentUpdates.operationsApprovals') }}</span>{{ $t('platform.agentUpdates.planAppliesAfter') }}
      </div>
    </PlanReviewDialog>
  </div>
</template>
