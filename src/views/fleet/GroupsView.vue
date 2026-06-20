<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  FolderTree,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  X,
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
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GROUP_COLOR_TOKENS, groupColor } from "@/lib/groupColors";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

const groupsQuery = useAsyncData(() => api.groups.list(), { pollInterval: 0 });
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});

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
const selectedId = ref<string | undefined>(undefined);
const editing = ref<"new" | "existing" | null>(null);

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
  form.selTags = csv(g?.selector?.match_tags_any);
  form.selRoles = csv(g?.selector?.match_roles);
  form.selCountry = csv(g?.selector?.match_country);
  form.selContinent = csv(g?.selector?.match_continent);
  form.system = !!g?.system;
  memberSearch.value = "";
  previewCount.value = null;
}

function selectGroup(g: GroupView) {
  selectedId.value = g.id;
  editing.value = "existing";
  loadForm(g);
}

function startCreate() {
  selectedId.value = undefined;
  editing.value = "new";
  loadForm(undefined);
}

// Parent options exclude the group itself (server enforces full acyclicity).
const parentOptions = computed(() =>
  sortedGroups.value.filter((g) => g.id !== form.id),
);

/* ----------------------------------------------------------------- */
/* Explicit membership picker                                         */
/* ----------------------------------------------------------------- */
const memberSearch = ref("");

const filteredNodes = computed(() => {
  const q = memberSearch.value.trim().toLowerCase();
  const base = [...nodes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  if (!q) return base;
  return base.filter((n) =>
    [n.name, n.id, n.role].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
  );
});

function isMember(id: string): boolean {
  return form.members.includes(id);
}

function setMember(id: string, on: boolean) {
  const has = form.members.includes(id);
  if (on && !has) form.members.push(id);
  else if (!on && has) form.members = form.members.filter((m) => m !== id);
}

/* ----------------------------------------------------------------- */
/* Display-only selector + live preview                              */
/* ----------------------------------------------------------------- */
const previewCount = ref<number | null>(null);
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
/* Save / delete / seed                                              */
/* ----------------------------------------------------------------- */
const saving = ref(false);
const seeding = ref(false);

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
    selector: buildSelector(),
  };
}

async function save() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const saved = await api.groups.upsert(buildUpsert());
    toast.success(editing.value === "new" ? t("fleet.groups.toast.created") : t("fleet.groups.toast.saved"));
    await groupsQuery.refresh();
    selectedId.value = saved.id;
    editing.value = "existing";
    loadForm(groups.value.find((g) => g.id === saved.id) ?? saved);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.groups.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}

const deleteOpen = ref(false);
const deleting = ref(false);

async function confirmDelete() {
  if (!form.id) return;
  deleting.value = true;
  try {
    await api.groups.delete(form.id);
    toast.success(t("fleet.groups.toast.deleted"));
    deleteOpen.value = false;
    selectedId.value = undefined;
    editing.value = null;
    await groupsQuery.refresh();
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

async function seedFromTags() {
  if (!canAdmin.value) return;
  seeding.value = true;
  try {
    const res = await api.groups.seed();
    toast.success(t("fleet.groups.toast.seeded", { created: res.created, skipped: res.skipped }));
    await groupsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.groups.toast.seedFailed"));
  } finally {
    seeding.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('fleet.groups.title')" :description="$t('fleet.groups.description')">
      <template #status>
        <FreshnessLabel :last-updated="groupsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="groupsQuery.refreshing.value"
          @click="groupsQuery.refresh"
        >
          <RotateCw :class="cn('size-4', groupsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" variant="outline" size="sm" :disabled="seeding" @click="seedFromTags">
          <Sparkles class="size-4" aria-hidden="true" />
          {{ $t('fleet.groups.generateFromTags') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="startCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.groups.newGroup') }}
        </Button>
      </template>
    </PageHeader>

    <DataState
      :loading="groupsQuery.loading.value"
      :error="groupsQuery.error.value"
      :has-data="groupsQuery.data.value !== undefined"
      :is-empty="false"
      @retry="groupsQuery.refresh"
    >
      <div class="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <!-- Left: group list -->
        <Card class="h-fit">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <FolderTree class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.groups.listTitle') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.groups.listDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-1">
            <EmptyState
              v-if="groups.length === 0"
              :icon="FolderTree"
              :title="$t('fleet.groups.emptyTitle')"
              :description="$t('fleet.groups.emptyDescription')"
            >
              <Button v-if="canAdmin" size="sm" @click="startCreate">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('fleet.groups.newGroup') }}
              </Button>
            </EmptyState>

            <template v-else>
              <button
                v-for="g in sortedGroups"
                :key="g.id"
                type="button"
                :class="cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                  selectedId === g.id ? 'bg-muted' : 'hover:bg-muted/50',
                )"
                @click="selectGroup(g)"
              >
                <span :class="cn('size-2.5 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
                <span class="truncate font-medium">{{ g.name }}</span>
                <Badge variant="secondary" class="ml-auto shrink-0 tabular-nums">
                  {{ g.rollup.online }}/{{ g.rollup.total }}
                </Badge>
              </button>

              <!-- Ungrouped: read-only synthetic bucket -->
              <div
                v-if="ungrouped"
                class="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-2 text-sm text-muted-foreground"
              >
                <span class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
                <span class="truncate">{{ $t('fleet.groups.ungrouped') }}</span>
                <Badge variant="outline" class="ml-auto shrink-0 tabular-nums">
                  {{ ungrouped.rollup.online }}/{{ ungrouped.rollup.total }}
                </Badge>
              </div>
            </template>
          </CardContent>
        </Card>

        <!-- Right: editor / detail -->
        <Card v-if="editing" class="h-fit">
          <CardHeader>
            <CardTitle>
              {{ editing === 'new' ? $t('fleet.groups.createTitle') : (form.name || $t('fleet.groups.editTitle')) }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.groups.editorDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-6">
            <fieldset :disabled="!canAdmin" class="space-y-6">
              <!-- Identity -->
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label for="grp-name">{{ $t('fleet.groups.fieldName') }}</Label>
                  <Input id="grp-name" v-model="form.name" :placeholder="$t('fleet.groups.namePlaceholder')" />
                </div>
                <div class="grid gap-1.5">
                  <Label for="grp-slug">{{ $t('fleet.groups.fieldSlug') }}</Label>
                  <Input
                    id="grp-slug"
                    v-model="form.slug"
                    :disabled="editing === 'existing'"
                    :placeholder="effectiveSlug || 'web-edge'"
                  />
                  <p class="text-xs text-muted-foreground">
                    {{ editing === 'existing' ? $t('fleet.groups.slugImmutable') : $t('fleet.groups.slugHint') }}
                  </p>
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
                  <Label for="grp-icon">{{ $t('fleet.groups.fieldIcon') }}</Label>
                  <Input id="grp-icon" v-model="form.icon" :placeholder="$t('common.misc.optional')" />
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
                  <Label for="grp-order">{{ $t('fleet.groups.fieldOrder') }}</Label>
                  <Input id="grp-order" v-model.number="form.order" type="number" />
                </div>
                <div class="grid gap-1.5 sm:col-span-2">
                  <Label for="grp-desc">{{ $t('fleet.groups.fieldDescription') }}</Label>
                  <Input id="grp-desc" v-model="form.description" :placeholder="$t('common.misc.optional')" />
                </div>
              </div>

              <!-- Explicit membership -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <Label>{{ $t('fleet.groups.membersTitle') }}</Label>
                  <span class="text-xs text-muted-foreground">{{ $t('fleet.groups.membersCount', { n: form.members.length }) }}</span>
                </div>
                <p class="text-xs text-muted-foreground">{{ $t('fleet.groups.membersHint') }}</p>
                <div class="relative">
                  <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input v-model="memberSearch" class="pl-9" :placeholder="$t('fleet.groups.memberSearch')" />
                </div>
                <div class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1">
                  <label
                    v-for="n in filteredNodes"
                    :key="n.id"
                    class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
                  >
                    <Checkbox
                      :model-value="isMember(n.id)"
                      @update:model-value="(v) => setMember(n.id, v === true)"
                    />
                    <StatusDot :online="!!n.online && !n.disabled" :label="''" />
                    <span class="truncate">{{ n.name || n.id }}</span>
                    <span v-if="n.role" class="ml-auto shrink-0 text-xs text-muted-foreground">{{ n.role }}</span>
                  </label>
                  <p v-if="filteredNodes.length === 0" class="px-2 py-3 text-center text-xs text-muted-foreground">
                    {{ $t('fleet.groups.noNodes') }}
                  </p>
                </div>
                <div v-if="form.members.length" class="flex flex-wrap gap-1.5">
                  <Badge
                    v-for="id in form.members"
                    :key="id"
                    variant="secondary"
                    class="gap-1"
                  >
                    {{ nodeLabel(id) }}
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground"
                      :aria-label="$t('fleet.groups.removeMember')"
                      @click.prevent="setMember(id, false)"
                    >
                      <X class="size-3" />
                    </button>
                  </Badge>
                </div>
              </div>

              <!-- Display-only smart selector -->
              <div class="space-y-3 rounded-lg border border-border p-3">
                <div class="flex items-center justify-between">
                  <Label>{{ $t('fleet.groups.selectorTitle') }}</Label>
                  <Badge variant="outline">{{ $t('fleet.groups.displayOnly') }}</Badge>
                </div>
                <p class="text-xs text-muted-foreground">{{ $t('fleet.groups.selectorHint') }}</p>
                <div class="grid gap-3 sm:grid-cols-2">
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

              <!-- Effective (resolved) membership, read-only -->
              <div v-if="selectedGroup && editing === 'existing'" class="space-y-2">
                <Label>{{ $t('fleet.groups.resolvedTitle') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('fleet.groups.resolvedHint', { n: selectedGroup.resolved_members.length }) }}
                </p>
                <div v-if="selectedGroup.resolved_members.length" class="flex flex-wrap gap-1.5">
                  <Badge v-for="id in selectedGroup.resolved_members" :key="id" variant="outline">
                    {{ nodeLabel(id) }}
                  </Badge>
                </div>
              </div>
            </fieldset>

            <!-- Actions -->
            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <Button
                v-if="editing === 'existing' && canAdmin && !form.system"
                variant="ghost"
                size="sm"
                @click="deleteOpen = true"
              >
                <Trash2 class="size-4 text-destructive" aria-hidden="true" />
                {{ $t('common.actions.delete') }}
              </Button>
              <span v-else></span>
              <Button :disabled="!canSubmit || saving" @click="save">
                <RotateCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
                {{ editing === 'new' ? $t('fleet.groups.createGroup') : $t('common.actions.saveChanges') }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Right: nothing selected -->
        <Card v-else class="h-fit">
          <CardContent class="py-16">
            <EmptyState
              :icon="FolderTree"
              :title="$t('fleet.groups.noSelectionTitle')"
              :description="canRead ? $t('fleet.groups.noSelectionDescription') : $t('fleet.groups.needRead')"
            >
              <Button v-if="canAdmin" size="sm" @click="startCreate">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('fleet.groups.newGroup') }}
              </Button>
            </EmptyState>
          </CardContent>
        </Card>
      </div>
    </DataState>

    <ConfirmDialog
      :open="deleteOpen"
      :title="$t('fleet.groups.deleteTitle')"
      :description="`${$t('fleet.groups.deleteDescription', { name: form.name })}`"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteOpen = false; }"
      @confirm="confirmDelete"
    />
  </div>
</template>
