<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  Crown,
  FolderTree,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  ApiError,
  type GroupSelector,
  type GroupUpsertRequest,
  type GroupView,
  type Node,
} from "@/lib/api";
import { describeNodeStatus, nodeStatus } from "@/lib/nodeStatus";
import { splitNamePrefix } from "@/lib/fleet";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GROUP_COLOR_TOKENS, groupColor } from "@/lib/groupColors";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import { proofReason } from "@/components/common/proofModel";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import type { QueryRecord } from "@/components/common/tableUrlState";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("group:read"));
const canAdmin = computed(() => auth.can("group:admin"));

const ROOT_VALUE = "__root__";
const LEADER_NONE = "__none__";

// Rows carry member health, so both reads move: the group rollup gives the
// counts and the node list the names of members not reporting.
const POLL_MS = 15000;
const groupsQuery = useAsyncData((signal) => api.groups.list({ signal }), { pollInterval: POLL_MS });
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: POLL_MS,
});

/** Counts and names come from two reads; every refresh takes both. */
async function refreshAll(): Promise<void> {
  await Promise.all([groupsQuery.refresh(), nodesQuery.refresh()]);
}

const list = computed(() => groupsQuery.data.value);
const groups = computed<GroupView[]>(() => list.value?.groups ?? []);
const ungrouped = computed(() => list.value?.ungrouped);
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);

const nodeById = computed<Record<string, Node>>(() => {
  const m: Record<string, Node> = {};
  for (const n of nodes.value) m[n.id] = n;
  return m;
});

const sortedGroups = computed(() =>
  [...groups.value].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
);

function nodeLabel(id: string): string {
  return nodeById.value[id]?.name || shortId(id, 14);
}

/* ----------------------------------------------------------------- */
/* Master-detail selection + editor form                              */
/* ----------------------------------------------------------------- */
/**
 * The open group is in the address (?open=<id>), so a reload and a pasted
 * link land on it; ?open=new is the create form. Editing an existing group
 * happens in the same sheet.
 */
const owned = useOwnedRoute();
const sheet = bindRouteOpen(owned);
const NEW_GROUP = "new";
const creating = computed(() => sheet.openId.value === NEW_GROUP);
const editingExisting = ref(false);
const editing = computed<"new" | "existing" | null>(() => (creating.value ? "new" : editingExisting.value ? "existing" : null));
const selectedId = computed(() => (creating.value ? undefined : sheet.openId.value ?? undefined));

const selectedGroup = computed<GroupView | undefined>(() =>
  groups.value.find((g) => g.id === selectedId.value),
);

const form = reactive({
  id: undefined as string | undefined,
  name: "",
  slug: "",
  color: "slate",
  icon: "",
  description: "",
  parentId: ROOT_VALUE,
  order: 0,
  members: [] as string[],
  leaderId: LEADER_NONE,
  selTags: "",
  selRoles: "",
  selCountry: "",
  selContinent: "",
  system: false,
});

function csv(values?: string[]): string {
  return (values ?? []).join(", ");
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Declared before loadForm runs: ?open=new loads the create form during setup.
const memberSearch = ref("");
const memberQuickTag = ref("");
const previewCount = ref<number | null>(null);

function loadForm(g?: GroupView) {
  form.id = g?.id;
  form.name = g?.name ?? "";
  form.slug = g?.slug ?? "";
  form.color = g?.color || "slate";
  form.icon = g?.icon ?? "";
  form.description = g?.description ?? "";
  form.parentId = g?.parent_id || ROOT_VALUE;
  form.order = g?.order ?? 0;
  form.members = [...(g?.members ?? [])];
  form.leaderId = g?.leader_id || LEADER_NONE;
  form.selTags = csv(g?.selector?.match_tags_any);
  form.selRoles = csv(g?.selector?.match_roles);
  form.selCountry = csv(g?.selector?.match_country);
  form.selContinent = csv(g?.selector?.match_continent);
  form.system = !!g?.system;
  memberSearch.value = "";
  memberQuickTag.value = "";
  previewCount.value = null;
  formBaseline.value = formSnapshot();
}

/**
 * What the editor holds, to tell an edited draft from a loaded one. The
 * sheet is not modal from 768 px up, so a row click or a row menu while
 * editing would otherwise drop the draft without a word.
 */
function formSnapshot(): string {
  return JSON.stringify(form);
}
const formBaseline = ref("");
const draftDirty = computed(() => editing.value !== null && formSnapshot() !== formBaseline.value);

const discardOpen = ref(false);
let afterDiscard: (() => void) | undefined;

/** Run `action` now, or once the operator agrees to drop the draft. */
function unlessDraft(action: () => void): void {
  if (!draftDirty.value) {
    action();
    return;
  }
  afterDiscard = action;
  discardOpen.value = true;
}

function discardDraft(): void {
  const action = afterDiscard;
  afterDiscard = undefined;
  discardOpen.value = false;
  editingExisting.value = false;
  formBaseline.value = formSnapshot();
  action?.();
}

watch(discardOpen, (open) => {
  if (!open) afterDiscard = undefined;
});

/** A row click swaps the open group; the group already open stays as it is. */
function openGroup(group: GroupView, el?: HTMLElement): void {
  if (group.id === sheet.openId.value) return;
  unlessDraft(() => sheet.open(group.id, el));
}

function startEdit() {
  if (!selectedGroup.value) return;
  loadForm(selectedGroup.value);
  editingExisting.value = true;
}

function startCreate() {
  if (creating.value) return;
  unlessDraft(() => {
    editingExisting.value = false;
    loadForm(undefined);
    sheet.open(NEW_GROUP);
  });
}

// A different group (or none) leaves edit mode; the create form starts empty.
watch(
  () => sheet.openId.value,
  (id) => {
    editingExisting.value = false;
    if (id === NEW_GROUP) loadForm(undefined);
  },
  { immediate: true },
);

// Parent options exclude the group itself (server enforces full acyclicity).
const parentOptions = computed(() =>
  sortedGroups.value.filter((g) => g.id !== form.id),
);

/* ----------------------------------------------------------------- */
/* Explicit membership picker                                         */
/* ----------------------------------------------------------------- */
const filteredNodes = computed(() => {
  const q = memberSearch.value.trim().toLowerCase();
  const base = [...nodes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  if (!q) return base;
  return base.filter((n) =>
    [n.name, n.id, n.role].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
  );
});

const tagOptions = computed(() => {
  const tags = new Set<string>();
  for (const node of nodes.value) {
    for (const tag of node.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed) tags.add(trimmed);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
});

const quickTagMatches = computed(() => {
  const tag = memberQuickTag.value;
  if (!tag) return [];
  return nodes.value.filter((node) => (node.tags ?? []).includes(tag));
});

function isMember(id: string): boolean {
  return form.members.includes(id);
}

function setMember(id: string, on: boolean) {
  const has = form.members.includes(id);
  if (on && !has) form.members.push(id);
  else if (!on && has) {
    form.members = form.members.filter((m) => m !== id);
    // A leader must stay an explicit member; drop it when removed.
    if (form.leaderId === id) form.leaderId = LEADER_NONE;
  }
}

function selectMembersByTag() {
  if (!memberQuickTag.value) return;
  const next = new Set(form.members);
  for (const node of quickTagMatches.value) next.add(node.id);
  form.members = [...next].sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)));
}

/** Leader candidates are exactly the group's explicit members. */
const leaderOptions = computed(() =>
  form.members.map((id) => ({ id, label: nodeLabel(id) })),
);


/* ----------------------------------------------------------------- */
/* Dynamic selector + live preview                                   */
/* ----------------------------------------------------------------- */
const previewing = ref(false);
let previewTimer: ReturnType<typeof setTimeout> | undefined;

function buildSelector(): GroupSelector | null {
  const sel: GroupSelector = {};
  const tags = parseCsv(form.selTags);
  const roles = parseCsv(form.selRoles);
  const country = parseCsv(form.selCountry).map((c) => c.toUpperCase());
  const continent = parseCsv(form.selContinent).map((c) => c.toUpperCase());
  if (tags.length) sel.match_tags_any = tags;
  if (roles.length) sel.match_roles = roles;
  if (country.length) sel.match_country = country;
  if (continent.length) sel.match_continent = continent;
  return Object.keys(sel).length ? sel : null;
}

const hasSelector = computed(
  () => !!(form.selTags || form.selRoles || form.selCountry || form.selContinent).trim(),
);

watch(
  () => [form.selTags, form.selRoles, form.selCountry, form.selContinent].join("|"),
  () => {
    if (previewTimer) clearTimeout(previewTimer);
    const sel = buildSelector();
    if (!sel) {
      previewCount.value = null;
      return;
    }
    previewTimer = setTimeout(async () => {
      previewing.value = true;
      try {
        const res = await api.groups.preview(sel);
        previewCount.value = res.count;
      } catch {
        previewCount.value = null;
      } finally {
        previewing.value = false;
      }
    }, 350);
  },
);

/* ----------------------------------------------------------------- */
/* Save / delete                                                      */
/* ----------------------------------------------------------------- */
const saving = ref(false);

const trimmedName = computed(() => form.name.trim());
const effectiveSlug = computed(() => form.slug.trim() || slugify(form.name));
const canSubmit = computed(
  () => canAdmin.value && !!trimmedName.value && !!effectiveSlug.value,
);

function buildUpsert(): GroupUpsertRequest {
  return {
    id: form.id,
    name: trimmedName.value,
    slug: effectiveSlug.value,
    color: form.color,
    icon: form.icon.trim() || undefined,
    description: form.description.trim() || undefined,
    parent_id: form.parentId === ROOT_VALUE ? undefined : form.parentId,
    order: Number.isFinite(form.order) ? form.order : 0,
    members: form.members,
    leader_id: form.leaderId === LEADER_NONE ? undefined : form.leaderId,
    selector: buildSelector(),
  };
}

async function save() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const saved = await api.groups.upsert(buildUpsert());
    const wasNew = creating.value;
    toast.success(wasNew ? t("fleet.groups.toast.created") : t("fleet.groups.toast.saved"));
    await refreshAll();
    editingExisting.value = false;
    if (wasNew) sheet.open(saved.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.groups.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}

const deleteOpen = ref(false);
const deleting = ref(false);
/** The group the confirm names; its own ref, so the editor's draft is never touched. */
const deleteTarget = ref<GroupView | undefined>();

function requestDelete(group: GroupView): void {
  deleteTarget.value = group;
  deleteOpen.value = true;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.groups.delete(target.id);
    toast.success(t("fleet.groups.toast.deleted"));
    deleteOpen.value = false;
    if (sheet.openId.value === target.id) {
      editingExisting.value = false;
      sheet.close();
    }
    await refreshAll();
  } catch (error) {
    // The server rejects (409) when the group has children or is referenced by
    // a group policy; surface that exact reason rather than a generic message.
    const message =
      error instanceof ApiError ? error.message : t("fleet.groups.toast.deleteFailed");
    toast.error(message);
    deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}

// An old /groups?selected=<id> link (node pages linked group chips there)
// lands on ?open=<id>, with replace.
watch(
  () => owned.query().selected,
  (selected) => {
    if (!owned.owns() || typeof selected !== "string" || !selected) return;
    const query: QueryRecord = { ...owned.query(), open: selected };
    delete query.selected;
    owned.replace(query);
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/* Head, rows and member health (design 23, 4.2)                       */
/* ------------------------------------------------------------------ */

// The line ages with the group read; a failed node read is its own segment,
// since the counts still stand without the names.
const proof = useProof(groupsQuery);
const proofSegments = computed<ProofSegment[]>(() => {
  const out: ProofSegment[] = [{ key: "groups", text: t("fleet.groups.proof.groups", { n: groups.value.length }, groups.value.length) }];
  if (ungrouped.value) out.push({ key: "ungrouped", text: t("fleet.groups.proof.ungrouped", { n: ungrouped.value.rollup.total }), tone: "muted" });
  if (nodesQuery.error.value) {
    const reason = proofReason(nodesQuery.error.value);
    out.push({
      key: "nodes",
      text: nodesQuery.data.value ? t("fleet.groups.proof.nodesStale", { reason }) : t("fleet.groups.proof.nodesNotRead", { reason }),
      tone: nodesQuery.data.value ? "warning" : "destructive",
    });
  }
  return out;
});

interface Health {
  total: number;
  online: number;
  disabled: number;
  /** Members not reporting, by name. */
  down: string[];
}

function healthOf(group: GroupView): Health {
  const down = group.resolved_members
    .map((id) => nodeById.value[id])
    .filter((node): node is Node => !!node && ["offline", "never_reported"].includes(nodeStatus(node)))
    .map((node) => splitNamePrefix(node).body);
  return { total: group.rollup.total, online: group.rollup.online, disabled: group.rollup.disabled ?? 0, down };
}

const columns = computed<DataTableColumn<GroupView>[]>(() => [
  { key: "name", label: t("fleet.groups.table.group"), sortable: true, value: (g) => g.name },
  { key: "health", label: t("fleet.groups.table.health"), sortable: true, value: (g) => (g.rollup.total ? g.rollup.online / g.rollup.total : 1) },
  // A column blank on every row says nothing; it shows once some group has a leader.
  ...(sortedGroups.value.some((g) => g.leader_id)
    ? [{ key: "leader", label: t("fleet.groups.fieldLeader"), value: (g: GroupView) => (g.leader_id ? nodeLabel(g.leader_id) : "") }]
    : []),
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

function menuFor(group: GroupView): RowMenuItem[] {
  return [
    {
      key: "edit",
      label: t("fleet.groups.edit"),
      icon: Pencil,
      hidden: !canAdmin.value,
      run: () => {
        if (group.id === sheet.openId.value && editingExisting.value) return;
        unlessDraft(() => {
          sheet.open(group.id);
          void Promise.resolve().then(startEdit);
        });
      },
    },
    {
      key: "delete",
      label: t("common.actions.delete"),
      icon: Trash2,
      danger: true,
      hidden: !canAdmin.value || !!group.system,
      run: () => requestDelete(group),
    },
  ];
}

const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (creating.value) return "ready" as const;
  if (groupsQuery.data.value === undefined) {
    return groupsQuery.error.value && !groupsQuery.loading.value ? ("failed" as const) : ("loading" as const);
  }
  if (!selectedGroup.value) return "gone" as const;
  return groupsQuery.error.value ? ("stale" as const) : ("ready" as const);
});

const sheetTitle = computed(() => {
  if (creating.value) return t("fleet.groups.createTitle");
  const name = selectedGroup.value?.name ?? sheet.openId.value ?? "";
  return editingExisting.value ? t("fleet.groups.editNamed", { name }) : name;
});

/** Members of the open group, worst first, with their status. */
const openMembers = computed(() =>
  (selectedGroup.value?.resolved_members ?? [])
    .map((id) => ({ id, node: nodeById.value[id] }))
    .sort((a, b) => {
      const order = (n?: Node) => (n ? ["never_reported", "offline", "degraded", "disabled", "online"].indexOf(nodeStatus(n)) : 5);
      return order(a.node) - order(b.node) || nodeLabel(a.id).localeCompare(nodeLabel(b.id));
    }),
);

function selectorSummary(group: GroupView): string {
  const sel = group.selector;
  if (!sel) return "";
  const parts: string[] = [];
  if (sel.match_tags_any?.length) parts.push(`${t("fleet.groups.matchTags")}: ${sel.match_tags_any.join(", ")}`);
  if (sel.match_roles?.length) parts.push(`${t("fleet.groups.matchRoles")}: ${sel.match_roles.join(", ")}`);
  if (sel.match_country?.length) parts.push(`${t("fleet.groups.matchCountry")}: ${sel.match_country.join(", ")}`);
  if (sel.match_continent?.length) parts.push(`${t("fleet.groups.matchContinent")}: ${sel.match_continent.join(", ")}`);
  return parts.join(" · ");
}

const deleteImpact = computed(() => {
  const target = deleteTarget.value;
  if (!target) return [];
  const members = groups.value.find((g) => g.id === target.id)?.resolved_members.length ?? target.resolved_members.length;
  return [t("fleet.groups.deleteImpact", { n: members })];
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.groups.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.groups.description') }}</p>
        <ProofLine v-if="canRead" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <!-- With no groups the empty state carries New group; the header does not repeat it. -->
        <Button v-if="canAdmin && !(list && groups.length === 0)" size="sm" type="button" @click="startCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.groups.newGroup') }}
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="groupsQuery.refreshing.value" @click="refreshAll">
          <RotateCw :class="cn('size-4', groupsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <EmptyState v-if="!canRead" :icon="FolderTree" :title="$t('fleet.groups.title')" :description="$t('fleet.groups.needRead')" />

    <template v-else>
      <DataTable
        :columns="columns"
        :rows="sortedGroups"
        :row-key="(group) => group.id"
        :loading="groupsQuery.loading.value"
        :error="groupsQuery.error.value ?? null"
        :has-data="groupsQuery.data.value !== undefined"
        :expression-filter="false"
        :show-summary="false"
        :row-click="openGroup"
        :active-row-id="selectedId ?? null"
        @retry="refreshAll"
      >
        <template #empty>
          <EmptyState
            :icon="FolderTree"
            :title="$t('fleet.groups.emptyTitle')"
            :description="canAdmin ? $t('fleet.groups.emptyDescription') : $t('fleet.groups.emptyDescriptionReadOnly')"
          >
            <Button v-if="canAdmin" size="sm" type="button" @click="startCreate">
              <Plus class="size-4" aria-hidden="true" />
              {{ $t('fleet.groups.newGroup') }}
            </Button>
          </EmptyState>
        </template>
        <template #cell-name="{ row }">
          <span class="flex min-w-0 items-center gap-2">
            <span :class="cn('size-2.5 shrink-0 rounded-full', groupColor(row.color).dot)" aria-hidden="true" />
            <span class="min-w-0">
              <span class="block truncate font-medium">{{ row.name }}</span>
              <span v-if="row.description" class="block truncate text-xs text-muted-foreground" :title="row.description">{{ row.description }}</span>
            </span>
          </span>
        </template>
        <template #cell-health="{ row }">
          <span class="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span class="tabular">{{ $t('fleet.groups.health.online', { online: healthOf(row).online, total: healthOf(row).total }) }}</span>
            <span v-if="healthOf(row).disabled" class="text-muted-foreground">{{ $t('fleet.groups.health.disabled', { n: healthOf(row).disabled }) }}</span>
            <span v-if="healthOf(row).down.length" class="text-destructive">{{ $t('fleet.groups.health.down', { names: healthOf(row).down.slice(0, 3).join(', ') + (healthOf(row).down.length > 3 ? ` +${healthOf(row).down.length - 3}` : '') }) }}</span>
          </span>
        </template>
        <template #cell-leader="{ row }">
          <span v-if="row.leader_id" class="inline-flex items-center gap-1 text-xs">
            <Crown class="size-3 text-warning-text" aria-hidden="true" />
            {{ nodeLabel(row.leader_id) }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu :name="row.name" :items="menuFor(row)" />
        </template>
      </DataTable>

      <!-- Nodes in no group: a fact about the fleet, not a group to open. -->
      <p v-if="ungrouped && groups.length" class="text-xs text-muted-foreground">
        {{ $t('fleet.groups.ungroupedLine', { n: ungrouped.rollup.total, online: ungrouped.rollup.online }) }}
      </p>
    </template>

    <!-- One group: its members and their state; the editor is the same sheet. -->
    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="sheetTitle"
      :subtitle="selectedGroup && !editing ? selectedGroup.slug : undefined"
      :state="sheetState"
      :error="groupsQuery.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.groups.sheet.goneTitle')"
      :gone-description="$t('fleet.groups.sheet.goneDescription')"
      @close="sheet.close"
      @retry="refreshAll"
    >
      <!-- Read: health, members, how membership is decided. -->
      <div v-if="!editing && selectedGroup" class="space-y-5 text-sm">
        <p v-if="selectedGroup.description" class="text-muted-foreground">{{ selectedGroup.description }}</p>
        <p class="flex flex-wrap items-baseline gap-x-2">
          <span class="font-medium tabular">{{ $t('fleet.groups.health.online', { online: healthOf(selectedGroup).online, total: healthOf(selectedGroup).total }) }}</span>
          <span v-if="healthOf(selectedGroup).down.length" class="text-destructive">{{ $t('fleet.groups.health.down', { names: healthOf(selectedGroup).down.join(', ') }) }}</span>
        </p>
        <section class="space-y-2" :aria-label="$t('fleet.groups.resolvedTitle')">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.groups.sheet.membersCount', { n: selectedGroup.resolved_members.length }, selectedGroup.resolved_members.length) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="member in openMembers" :key="member.id">
              <RouterLink
                :to="{ name: 'node-detail', params: { id: member.id } }"
                class="flex items-center gap-2 px-3 py-2 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <StatusDot v-if="member.node" :status="describeNodeStatus(member.node).health" />
                <span class="min-w-0 truncate">{{ nodeLabel(member.id) }}</span>
                <Crown v-if="member.id === selectedGroup.leader_id" class="size-3 shrink-0 text-warning-text" :aria-label="$t('fleet.groups.fieldLeader')" />
                <span v-if="!(selectedGroup.members ?? []).includes(member.id)" class="ms-auto shrink-0 text-xs text-muted-foreground">{{ $t('fleet.groups.sheet.bySelector') }}</span>
                <span
                  v-else-if="member.node && nodeStatus(member.node) !== 'online'"
                  class="ms-auto shrink-0 text-xs text-muted-foreground"
                >{{ $t(describeNodeStatus(member.node).labelKey) }}</span>
              </RouterLink>
            </li>
            <li v-if="openMembers.length === 0" class="px-3 py-4 text-xs text-muted-foreground">{{ $t('fleet.groups.sheet.noMembers') }}</li>
          </ul>
        </section>
        <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.groups.membersTitle') }}</dt>
          <dd>{{ $t('fleet.groups.sheet.explicit', { n: (selectedGroup.members ?? []).length }) }}</dd>
          <template v-if="selectorSummary(selectedGroup)">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.groups.selectorTitle') }}</dt>
            <dd class="break-words">{{ selectorSummary(selectedGroup) }}</dd>
          </template>
          <template v-if="selectedGroup.parent_id">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.groups.fieldParent') }}</dt>
            <dd>{{ groups.find((g) => g.id === selectedGroup?.parent_id)?.name ?? selectedGroup.parent_id }}</dd>
          </template>
        </dl>
      </div>

      <!-- Edit and create. -->
      <fieldset v-else-if="editing" :disabled="!canAdmin" class="space-y-6 text-sm">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="grid gap-1.5">
            <Label for="grp-name">{{ $t('fleet.groups.fieldName') }}</Label>
            <Input id="grp-name" v-model="form.name" :placeholder="$t('fleet.groups.namePlaceholder')" />
          </div>
          <div class="grid gap-1.5">
            <Label for="grp-slug">{{ $t('fleet.groups.fieldSlug') }}</Label>
            <Input id="grp-slug" v-model="form.slug" :disabled="editing === 'existing'" :placeholder="effectiveSlug || 'web-edge'" />
            <p class="text-xs text-muted-foreground">{{ editing === 'existing' ? $t('fleet.groups.slugImmutable') : $t('fleet.groups.slugHint') }}</p>
          </div>
          <div class="grid gap-1.5">
            <Label>{{ $t('fleet.groups.fieldColor') }}</Label>
            <Select v-model="form.color">
              <SelectTrigger class="w-full">
                <span class="flex items-center gap-2">
                  <span :class="cn('size-3 rounded-full', groupColor(form.color).dot)" aria-hidden="true" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="token in GROUP_COLOR_TOKENS" :key="token" :value="token">
                  <span class="flex items-center gap-2">
                    <span :class="cn('size-3 rounded-full', groupColor(token).dot)" aria-hidden="true" />
                    {{ token }}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label>{{ $t('fleet.groups.fieldParent') }}</Label>
            <Select v-model="form.parentId">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ROOT_VALUE">{{ $t('fleet.groups.parentRoot') }}</SelectItem>
                <SelectItem v-for="g in parentOptions" :key="g.id" :value="g.id">{{ g.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="grp-icon">{{ $t('fleet.groups.fieldIcon') }}</Label>
            <Input id="grp-icon" v-model="form.icon" :placeholder="$t('common.misc.optional')" />
          </div>
          <div class="grid gap-1.5">
            <Label for="grp-order">{{ $t('fleet.groups.fieldOrder') }}</Label>
            <Input id="grp-order" v-model.number="form.order" type="number" />
          </div>
          <div class="grid gap-1.5 sm:col-span-2">
            <Label for="grp-desc">{{ $t('fleet.groups.fieldDescription') }}</Label>
            <Input id="grp-desc" v-model="form.description" :placeholder="$t('common.misc.optional')" />
          </div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <Label>{{ $t('fleet.groups.membersTitle') }}</Label>
            <span class="text-xs text-muted-foreground">{{ $t('fleet.groups.membersCount', { n: form.members.length }) }}</span>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.groups.membersHint') }}</p>
          <div v-if="tagOptions.length" class="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2 sm:flex-row sm:items-end">
            <div class="grid flex-1 gap-1.5">
              <Label class="text-xs">{{ $t('fleet.groups.quickTag') }}</Label>
              <Select v-model="memberQuickTag">
                <SelectTrigger class="w-full"><SelectValue :placeholder="$t('fleet.groups.quickTagPlaceholder')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="tag in tagOptions" :key="tag" :value="tag">{{ tag }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="outline" size="sm" :disabled="!memberQuickTag || quickTagMatches.length === 0" @click="selectMembersByTag">
              {{ $t('fleet.groups.selectTaggedCount', { n: quickTagMatches.length }) }}
            </Button>
          </div>
          <div class="relative">
            <Search class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input v-model="memberSearch" class="ps-9" :placeholder="$t('fleet.groups.memberSearch')" />
          </div>
          <p v-if="nodesQuery.error.value" class="text-xs text-destructive">{{ nodesQuery.error.value.message }}</p>
          <div v-else class="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
            <label v-for="n in filteredNodes" :key="n.id" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50 pointer-coarse:min-h-11">
              <Checkbox :model-value="isMember(n.id)" @update:model-value="(v) => setMember(n.id, v === true)" />
              <StatusDot :status="describeNodeStatus(n).health" :label="''" />
              <span class="truncate" :title="n.name || n.id">{{ n.name || n.id }}</span>
              <span v-if="n.role" class="ms-auto shrink-0 text-xs text-muted-foreground">{{ n.role }}</span>
            </label>
            <p v-if="filteredNodes.length === 0" class="px-2 py-3 text-xs text-muted-foreground">{{ $t('fleet.groups.noNodes') }}</p>
          </div>
        </div>

        <div class="grid gap-1.5">
          <Label>{{ $t('fleet.groups.fieldLeader') }}</Label>
          <Select v-model="form.leaderId">
            <SelectTrigger class="w-full">
              <span class="flex items-center gap-2">
                <Crown class="size-3.5 text-warning-text" aria-hidden="true" />
                <SelectValue :placeholder="$t('fleet.groups.leaderNone')" />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="LEADER_NONE">{{ $t('fleet.groups.leaderNone') }}</SelectItem>
              <SelectItem v-for="opt in leaderOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.groups.leaderHint') }}</p>
        </div>

        <div class="space-y-3 rounded-lg border border-border p-3">
          <Label>{{ $t('fleet.groups.selectorTitle') }}</Label>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.groups.selectorHint') }}</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5">
              <Label class="text-xs">{{ $t('fleet.groups.matchTags') }}</Label>
              <Input v-model="form.selTags" placeholder="edge, prod" />
            </div>
            <div class="grid gap-1.5">
              <Label class="text-xs">{{ $t('fleet.groups.matchRoles') }}</Label>
              <Input v-model="form.selRoles" placeholder="web, db" />
            </div>
            <div class="grid gap-1.5">
              <Label class="text-xs">{{ $t('fleet.groups.matchCountry') }}</Label>
              <Input v-model="form.selCountry" placeholder="US, DE" />
            </div>
            <div class="grid gap-1.5">
              <Label class="text-xs">{{ $t('fleet.groups.matchContinent') }}</Label>
              <Input v-model="form.selContinent" placeholder="AS, EU" />
            </div>
          </div>
          <p v-if="hasSelector" class="text-xs text-muted-foreground">
            <span v-if="previewing">{{ $t('fleet.groups.previewLoading') }}</span>
            <span v-else-if="previewCount !== null">{{ $t('fleet.groups.previewMatches', { n: previewCount }) }}</span>
          </p>
        </div>
      </fieldset>

      <template v-if="canAdmin && (editing || selectedGroup)" #actions>
        <template v-if="editing">
          <Button
            v-if="editing === 'existing' && !form.system"
            variant="ghost"
            size="sm"
            type="button"
            class="me-auto text-destructive"
            @click="selectedGroup && requestDelete(selectedGroup)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
          <Button variant="outline" size="sm" type="button" @click="creating ? sheet.close() : (editingExisting = false)">
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button size="sm" type="button" :disabled="!canSubmit || saving" @click="save">
            <RotateCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            {{ editing === 'new' ? $t('fleet.groups.createGroup') : $t('common.actions.saveChanges') }}
          </Button>
        </template>
        <Button v-else size="sm" type="button" @click="startEdit">
          <Pencil class="size-4" aria-hidden="true" />
          {{ $t('fleet.groups.edit') }}
        </Button>
      </template>
    </ObjectSheet>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.groups.deleteTitle')"
      :description="$t('fleet.groups.deleteDescription', { name: deleteTarget?.name ?? '' })"
      :impact="deleteImpact"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @confirm="confirmDelete"
    />

    <!-- Leaving an edited draft: say what is lost, keep editing by default.
         Destructive like every other discard confirm in the console. -->
    <ConfirmDialog
      v-model:open="discardOpen"
      variant="destructive"
      :title="$t('fleet.groups.discard.title')"
      :description="editing === 'new' ? $t('fleet.groups.discard.descriptionNew') : $t('fleet.groups.discard.description', { name: selectedGroup?.name ?? '' })"
      :confirm-label="$t('fleet.groups.discard.confirm')"
      :cancel-label="$t('fleet.groups.discard.keep')"
      @confirm="discardDraft"
    />
  </div>
</template>
