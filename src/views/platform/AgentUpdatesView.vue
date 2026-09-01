<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  BookOpen,
  DownloadCloud,
  ExternalLink,
  FileCode2,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
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
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  (signal) => (canPlan.value ? api.approvals.list(undefined, { signal }).then((r) => unwrap(r, "approvals")) : Promise.resolve([] as ApprovalView[])),
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

const sortedPolicies = computed(() =>
  [...policies.value].sort((a, b) => a.node_id.localeCompare(b.node_id)),
);

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
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function staleApprovalCount(nodeId: string): number {
  return staleApprovalsByNode.value.get(nodeId)?.length ?? 0;
}

const columns = computed<DataTableColumn<AgentUpdatePolicy>[]>(() => {
  const cols: DataTableColumn<AgentUpdatePolicy>[] = [
    { key: "node_id", label: t("platform.agentUpdates.colNode"), sortable: true, searchable: true, value: (p) => nodeName(p.node_id) },
    {
      key: "state",
      label: t("platform.agentUpdates.colState"),
      sortable: true,
      // The cell renders enabled + auto_plan; sort on the same pair.
      value: (p) => (p.enabled ? 2 : 0) + (p.auto_plan ? 1 : 0),
    },
    { key: "target_version", label: t("platform.agentUpdates.colTarget"), sortable: true, class: "font-mono text-xs" },
    { key: "last_applied_version", label: t("platform.agentUpdates.colApplied"), sortable: true, class: "font-mono text-xs" },
    { key: "last_planned_at", label: t("platform.agentUpdates.colLastPlanned"), sortable: true, class: "text-xs text-muted-foreground" },
    { key: "binary_url", label: t("platform.agentUpdates.colBinaryUrl"), sortable: true, searchable: true },
    { key: "sha256", label: t("platform.agentUpdates.colSha256"), sortable: true },
  ];
  if (canPlan.value || canAdmin.value) {
    cols.push({ key: "actions", label: t("platform.agentUpdates.colActions"), align: "right" });
  }
  return cols;
});

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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.agentUpdates.title')"
      :description="$t('platform.agentUpdates.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="policiesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" as-child>
          <a :href="AGENT_UPDATES_GUIDE_URL" target="_blank" rel="noreferrer">
            <BookOpen aria-hidden="true" class="size-4" />
            {{ $t('common.actions.docs') }}
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="policiesQuery.refreshing.value"
          @click="policiesQuery.refresh"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.agentUpdates.newPolicy') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader class="pb-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <DownloadCloud aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.agentUpdates.releaseTitle') }}
            </CardTitle>
            <CardDescription>{{ $t('platform.agentUpdates.releaseHint') }}</CardDescription>
          </div>
          <a
            v-if="releaseInfo?.release_url"
            :href="releaseInfo.release_url"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            {{ $t('platform.agentUpdates.openRelease') }}
            <ExternalLink class="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="releaseQuery.error.value" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
          {{ releaseQuery.error.value.message }}
        </div>
        <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('platform.agentUpdates.latestVersion') }}</p>
            <p class="mt-1 font-mono text-xl font-semibold">{{ releaseInfo?.latest_version || $t('platform.agentUpdates.latestUnknown') }}</p>
            <p class="text-xs text-muted-foreground">{{ releaseInfo?.latest_tag || "latest" }}</p>
          </div>
          <div>
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('platform.agentUpdates.releaseRepo') }}</p>
            <p class="mt-1 font-mono text-sm">{{ releaseInfo?.repo || "LatticeNet/lattice-node-agent" }}</p>
            <p class="text-xs text-muted-foreground">{{ releaseFetchedLabel() }}</p>
          </div>
          <div>
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('platform.agentUpdates.releaseArtifacts') }}</p>
            <p class="mt-1 text-xl font-semibold tabular">{{ releaseInfo?.artifacts?.length ?? 0 }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.releaseArtifactsHint') }}</p>
          </div>
          <div>
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('platform.agentUpdates.integrity') }}</p>
            <p class="mt-1 text-sm font-medium">{{ $t('platform.agentUpdates.integrityPlanBound') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.integrityHint') }}</p>
          </div>
        </div>
        <div v-if="prereleaseCandidates.length" class="mt-4 border-t border-border pt-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {{ $t('platform.agentUpdates.releaseCandidates') }}
            </span>
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
          <p class="mt-2 text-xs text-muted-foreground">{{ $t('platform.agentUpdates.releaseCandidatesHint') }}</p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <CardTitle class="flex items-center gap-2">
              <ServerCog aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.agentUpdates.distributionTitle') }}
            </CardTitle>
            <CardDescription class="max-w-3xl">
              {{ $t('platform.agentUpdates.distributionHint') }}
            </CardDescription>
          </div>
          <Badge variant="outline" class="shrink-0 font-mono text-xs">{{ artifactStorageLabel }}</Badge>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <div
          v-if="artifactsQuery.error.value"
          class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
        >
          {{ artifactsQuery.error.value.message }}
        </div>

        <div
          v-if="distributionDisabled"
          class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{{ $t('platform.agentUpdates.distributionDisabled') }}</span>
        </div>

        <div v-if="!artifacts.length && !artifactsQuery.error.value" class="rounded-md border border-dashed border-border p-4">
          <p class="text-sm font-medium">{{ $t('platform.agentUpdates.distributionEmptyTitle') }}</p>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ $t('platform.agentUpdates.distributionEmptyDescription') }}
          </p>
        </div>

        <div v-else-if="artifacts.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.artifactColVersion') }}</th>
                <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.artifactColPlatform') }}</th>
                <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.artifactColDigest') }}</th>
                <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.artifactColSize') }}</th>
                <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.artifactColStored') }}</th>
                <th scope="col" class="py-2 font-medium text-right">{{ $t('platform.agentUpdates.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="artifact in artifacts"
                :key="`${artifact.version}/${artifact.os}/${artifact.arch}`"
                class="border-b border-border/60 last:border-0"
              >
                <td class="py-2 pr-4 font-mono text-xs font-medium">{{ artifact.version }}</td>
                <td class="py-2 pr-4 font-mono text-xs text-muted-foreground">{{ artifact.os }}/{{ artifact.arch }}</td>
                <td class="py-2 pr-4">
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono text-xs text-muted-foreground">{{ artifact.sha256.slice(0, 16) }}</span>
                    <CopyButton :value="artifact.sha256" />
                  </div>
                </td>
                <td class="py-2 pr-4 tabular text-xs">{{ formatBytes(artifact.size_bytes) }}</td>
                <td class="py-2 pr-4 tabular text-xs text-muted-foreground">{{ formatBytes(artifact.stored_bytes) }}</td>
                <td class="py-2 text-right">
                  <Button
                    v-if="canAdmin"
                    variant="ghost"
                    size="icon"
                    :aria-label="$t('platform.agentUpdates.deleteArtifactAria')"
                    @click="artifactDeleteTarget = artifact"
                  >
                    <Trash2 aria-hidden="true" class="size-4" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="canAdmin" class="border-t border-border pt-4">
          <p class="text-sm font-medium">{{ $t('platform.agentUpdates.importTitle') }}</p>
          <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
            {{ $t('platform.agentUpdates.importHint') }}
          </p>
          <div class="mt-3 flex flex-wrap items-end gap-4">
            <div class="grid gap-1.5">
              <Label for="agent-artifact-version">{{ $t('platform.agentUpdates.importVersionLabel') }}</Label>
              <Input
                id="agent-artifact-version"
                v-model="importVersion"
                class="w-56 font-mono"
                :placeholder="$t('platform.agentUpdates.importVersionPlaceholder')"
              />
            </div>
            <fieldset class="grid gap-1.5">
              <legend class="text-sm font-medium">{{ $t('platform.agentUpdates.importArchLabel') }}</legend>
              <div class="flex items-center gap-4 pt-1">
                <label v-for="arch in AGENT_ARCHES" :key="arch" class="flex items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="importArches.includes(arch)"
                    @update:model-value="(v) => toggleImportArch(arch, v === true)"
                  />
                  <span class="font-mono">{{ arch }}</span>
                </label>
              </div>
            </fieldset>
            <Button :disabled="importing || !importArches.length" @click="runImport">
              <RefreshCw v-if="importing" aria-hidden="true" class="size-4 animate-spin" />
              <DownloadCloud v-else aria-hidden="true" class="size-4" />
              {{ importing ? $t('platform.agentUpdates.importing') : $t('platform.agentUpdates.importAction') }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <DownloadCloud aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.agentUpdates.policiesTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('platform.agentUpdates.policiesCount', { count: policies.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          v-if="staleAgentUpdateApprovals.length"
          class="mb-4 flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground md:flex-row md:items-start md:justify-between"
        >
          <div class="flex min-w-0 items-start gap-2">
            <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div class="min-w-0">
              <p class="font-medium text-foreground">
                {{ $t('platform.agentUpdates.staleApprovalSummary', { count: staleAgentUpdateApprovals.length }) }}
              </p>
              <p class="mt-1">
                {{ $t('platform.agentUpdates.staleApprovalSummaryHint') }}
              </p>
            </div>
          </div>
          <Button as-child variant="outline" size="sm" class="shrink-0">
            <RouterLink to="/approvals">
              <ExternalLink class="size-4" aria-hidden="true" />
              {{ $t('platform.agentUpdates.openApprovals') }}
            </RouterLink>
          </Button>
        </div>

        <DataTable
          state-key="updates"
          :columns="columns"
          :rows="sortedPolicies"
          :row-key="(policy) => policy.node_id"
          :loading="policiesQuery.loading.value"
          :error="policiesQuery.error.value"
          :has-data="policiesQuery.data.value !== undefined"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchNodes')"
          :empty-title="$t('platform.agentUpdates.emptyTitle')"
          :empty-description="$t('platform.agentUpdates.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="policiesQuery.refresh"
        >
          <template #cell-node_id="{ row }">
            <div class="font-medium">{{ nodeName(row.node_id) }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</div>
          </template>
          <template #cell-state="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge :variant="row.enabled ? 'success' : 'secondary'">
                {{ row.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
              </Badge>
              <Badge :variant="row.auto_plan ? 'info' : 'outline'">
                {{ row.auto_plan ? $t('platform.agentUpdates.autoPlan') : $t('platform.agentUpdates.manual') }}
              </Badge>
            </div>
            <p
              v-if="row.last_error"
              class="mt-1 max-w-[220px] break-words text-xs text-destructive"
              :title="row.last_error"
            >
              {{ row.last_error }}
            </p>
            <Badge v-if="staleApprovalCount(row.node_id)" variant="warning" class="mt-1">
              {{ $t('platform.agentUpdates.staleApprovalBadge', { count: staleApprovalCount(row.node_id) }) }}
            </Badge>
          </template>
          <template #cell-target_version="{ row }">
            <span class="font-mono text-xs">{{ targetLabel(row) }}</span>
            <p v-if="row.last_planned_version && row.last_planned_version !== row.target_version" class="text-xs text-muted-foreground">
              {{ $t('platform.agentUpdates.resolvedPlanned', { version: row.last_planned_version }) }}
            </p>
          </template>
          <!--
            last_applied_version is only ever written from a version the node
            itself reported (heartbeat confirmation, or the noop path where the
            node already runs the target). Empty means the node has never
            confirmed one through this policy, not that it runs no agent.
          -->
          <template #cell-last_applied_version="{ row }">
            <span v-if="row.last_applied_version" class="font-mono text-xs">{{ row.last_applied_version }}</span>
            <span v-else class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.appliedUnconfirmed') }}</span>
          </template>
          <template #cell-last_planned_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ row.last_planned_at ? formatDateTime(row.last_planned_at) : $t('common.misc.never') }}</span>
          </template>
          <template #cell-binary_url="{ row }">
            <div v-if="row.binary_url" class="flex items-center gap-1">
              <code class="max-w-[200px] truncate font-mono text-xs" :title="row.binary_url">
                {{ row.binary_url }}
              </code>
              <CopyButton :value="row.binary_url" />
            </div>
            <Badge v-else variant="outline">{{ $t('platform.agentUpdates.officialRelease') }}</Badge>
          </template>
          <template #cell-sha256="{ row }">
            <div v-if="row.sha256" class="flex items-center gap-1">
              <code class="font-mono text-xs">{{ shortId(row.sha256, 12) }}</code>
              <CopyButton :value="row.sha256" />
            </div>
            <span v-else class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.resolvedInPlan') }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                v-if="canPlan"
                variant="ghost"
                size="sm"
                :disabled="planning === row.node_id"
                @click="runPlan(row.node_id, false)"
              >
                <RefreshCw v-if="planning === row.node_id" aria-hidden="true" class="size-4 animate-spin" />
                <FileCode2 v-else aria-hidden="true" class="size-4" />
                {{ $t('platform.agentUpdates.plan') }}
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.agentUpdates.editPolicyAria')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.agentUpdates.deletePolicyAria')"
                @click="deleteTarget = row"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

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
          <div class="grid gap-3 lg:grid-cols-3">
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

          <div class="grid gap-3 sm:grid-cols-2">
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

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('platform.agentUpdates.deletePolicyTitle')"
      :description="$t('platform.agentUpdates.deletePolicyConfirm', { node: deleteTarget ? nodeName(deleteTarget.node_id) : '' })"
      :confirm-label="$t('common.actions.delete')"
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
