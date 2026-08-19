<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Lock, PackageOpen, Play, Puzzle, RefreshCw } from "lucide-vue-next";
import {
  api,
  type PluginViewAction,
  type PluginViewColumn,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import {
  isAllowedColumnRender,
  isAllowedFieldKind,
  isAllowedViewKind,
  usePluginContributions,
} from "@/composables/usePluginContributions";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import PluginFrameHost from "./PluginFrameHost.vue";
import { bridgeInterfaceFingerprint, interfaceMethodScopes } from "./pluginBridgeModel";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
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

type Row = Record<string, unknown>;

const route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();
const { ready, findPlugin, findView } = usePluginContributions();

// The component remounts per route (AppLayout keys RouterView by route.path), so
// reading params reactively is enough, but we keep them computed for safety.
const pluginId = computed(() => String(route.params.pluginId ?? ""));
const viewRoute = computed(() => {
  const raw = route.params.route;
  return Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
});

const plugin = computed(() => findPlugin(pluginId.value));
const view = computed(() => findView(pluginId.value, viewRoute.value));

const pageTitle = computed(() => view.value?.title || plugin.value?.name || t("pluginViews.fallbackTitle"));
const sectionLabel = computed(() => plugin.value?.name || t("nav.sections.platform"));
const rawKind = computed(() => view.value?.kind ?? "");
const supportedKind = computed(() => {
  if (!view.value || !isAllowedViewKind(rawKind.value)) return false;
  if (rawKind.value === "sandbox") {
    return plugin.value?.ui_runtime?.mode === "sandbox" && !!plugin.value.ui_runtime.entry_url;
  }
  return true;
});
const kind = computed(() => (supportedKind.value ? rawKind.value : ""));
const callableInterfaceFingerprint = computed(() => bridgeInterfaceFingerprint(plugin.value?.interfaces ?? []));

// ── Scope gating ──────────────────────────────────────────────────────────────
// Prefer the source interface contract's declared scopes (the precise gate for
// the data call); fall back to the nav entry that targets this route. Empty ⇒
// open. The server re-checks these on every gateway call regardless.
const requiredScopes = computed<string[]>(() => {
  const p = plugin.value;
  const v = view.value;
  if (!p || !v) return [];
  if (v.source?.interface) {
    const contract = p.interfaces?.find((i) => i.service === v.source!.interface);
    const scopes = interfaceMethodScopes(contract, v.source.method);
    if (scopes.length) return scopes;
  }
  const navEntry = p.ui?.nav?.find((n) => n.route === v.route);
  return navEntry?.scopes ?? [];
});
const hasAccess = computed(() => auth.canAll(requiredScopes.value));

// ── Data source (table / detail / kv / markdown share one fetch) ─────────────
const hasSource = computed(() => !!view.value?.source?.interface && !!view.value?.source?.method);

const sourceQuery = useAsyncData(
  async () => {
    const v = view.value;
    if (!v?.source?.interface || !v.source.method) return undefined;
    return api.plugins.call<unknown>(pluginId.value, v.source.interface, v.source.method);
  },
  { immediate: false },
);

// Fetch once the view resolves (the registry may load after mount) and access is
// granted. hasSource flips false→true when the contribution arrives.
watch(
  [hasAccess, hasSource],
  ([access, source]) => {
    if (access && source) sourceQuery.refresh();
  },
  { immediate: true },
);

// ── Value coercion + render hints ────────────────────────────────────────────
function toText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** Placeholder for a cell with no value. */
const noneLabel = computed(() => t("common.misc.none"));

// Mask a credential-bearing value: keep a recognisable scheme, hide the rest.
function maskSecret(v: unknown): string {
  const s = toText(v);
  if (!s) return noneLabel.value;
  const idx = s.indexOf("://");
  if (idx > 0) return `${s.slice(0, idx)}://••••••`;
  return "••••••";
}
// A render hint outside the allow-list is treated as plain text (inert).
function renderOf(col: PluginViewColumn): string {
  return isAllowedColumnRender(col.render) ? col.render ?? "" : "";
}

function asRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const rows = (data as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}
const rows = computed<Row[]>(() => asRows(sourceQuery.data.value));

/**
 * A column is sortable and searchable only when every row holds a scalar there.
 * Objects and arrays have no meaningful ordering, and secrets stay out of the
 * search index so a masked column never matches on its plaintext.
 */
function isScalarKey(key: string): boolean {
  return rows.value.every((r) => {
    const v = r[key];
    return v == null || typeof v !== "object";
  });
}

const columns = computed<DataTableColumn<Row>[]>(() => {
  const declared = view.value?.columns ?? [];
  if (declared.length) {
    return declared.map((c) => {
      const render = renderOf(c);
      const scalar = isScalarKey(c.key);
      return {
        key: c.key,
        label: c.label || c.key,
        align: render === "copy-secret" || render === "bytes" ? "right" : undefined,
        sortable: scalar && render !== "copy-secret",
        searchable: scalar && render !== "copy-secret",
        value: (r: Row) => r[c.key],
      } satisfies DataTableColumn<Row>;
    });
  }
  // Fallback: derive columns from the first row's keys.
  const first = rows.value[0];
  if (!first) return [];
  return Object.keys(first).map((k) => ({
    key: k,
    label: k,
    sortable: isScalarKey(k),
    searchable: isScalarKey(k),
    value: (r: Row) => r[k],
  }));
});

const hasSearchableColumn = computed(() => columns.value.some((c) => c.searchable));

const renderByKey = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const c of view.value?.columns ?? []) map[c.key] = renderOf(c);
  return map;
});

// Stable, unique per-fetch row keys (index-disambiguated so duplicate ids/JSON
// never collide).
const rowKeys = computed(() => {
  const m = new Map<Row, string>();
  rows.value.forEach((r, i) => {
    const primary =
      ["id", "node_id", "name", "key"].map((k) => r[k]).find((v) => v != null) ?? JSON.stringify(r);
    m.set(r, `${String(primary)}#${i}`);
  });
  return m;
});
function keyOf(r: Row): string {
  return rowKeys.value.get(r) ?? JSON.stringify(r);
}
function cellSlot(key: string): string {
  return `cell-${key}`;
}

// ── kv / detail: render an object as a description list ───────────────────────
const kvObject = computed<Row | undefined>(() => {
  if (kind.value === "detail") return rows.value[0];
  const data = sourceQuery.data.value;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Row;
    if (Array.isArray(obj.rows)) return rows.value[0]; // {rows,count} envelope
    return obj;
  }
  return rows.value[0];
});
const kvEntries = computed<[string, unknown][]>(() =>
  kvObject.value ? Object.entries(kvObject.value) : [],
);

// ── markdown: render text safely (no executable HTML, strict CSP holds) ──────
const markdownText = computed<string>(() => {
  const data = sourceQuery.data.value;
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Row;
    for (const key of ["markdown", "text", "content", "body"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    return JSON.stringify(data, null, 2);
  }
  return data === undefined ? "" : String(data);
});

// ── Actions (gateway-driven; optional modal form) ────────────────────────────
const actions = computed<PluginViewAction[]>(() => view.value?.actions ?? []);

/** Scopes this action needs that the caller does not hold. */
function missingActionScopes(a: PluginViewAction): string[] {
  const contract = plugin.value?.interfaces?.find((i) => i.service === a.interface);
  const required = [...interfaceMethodScopes(contract, a.method), ...(a.scopes ?? [])];
  return required.filter((scope) => !auth.canAll([scope]));
}
function canRunAction(a: PluginViewAction): boolean {
  return missingActionScopes(a).length === 0;
}
/** Tooltip naming the exact scope a disabled action is waiting on. */
function actionTitle(a: PluginViewAction): string | undefined {
  const missing = missingActionScopes(a);
  if (!missing.length) return undefined;
  return t("platform.plugins.actionScopeMissing", { scopes: missing.join(", ") });
}
function hasForm(a: PluginViewAction): boolean {
  return Array.isArray(a.form) && a.form.some((f) => isAllowedFieldKind(f.kind));
}

// Keyed by position, not by label: two contributed actions may share a label,
// and a label-keyed flag makes them block and spin each other.
const runningIndex = ref<number | null>(null);
async function runAction(index: number, a: PluginViewAction, payload?: Record<string, unknown>) {
  if (!canRunAction(a) || runningIndex.value !== null) return;
  runningIndex.value = index;
  try {
    await api.plugins.call(pluginId.value, a.interface, a.method, payload);
    toast.success(t("pluginViews.actionDone", { label: a.label }));
    formOpen.value = false;
    confirmTarget.value = undefined;
    if (hasSource.value) sourceQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("pluginViews.actionFailed"));
  } finally {
    runningIndex.value = null;
  }
}

// Action form modal (text / int / select; unknown kinds skipped).
const formOpen = ref(false);
const formAction = ref<PluginViewAction | null>(null);
const formState = reactive<Record<string, string>>({});
const formFields = computed(() =>
  (formAction.value?.form ?? []).filter((f) => isAllowedFieldKind(f.kind)),
);

const formActionIndex = ref<number>(-1);

function openActionForm(index: number, a: PluginViewAction) {
  if (!canRunAction(a)) return;
  formAction.value = a;
  formActionIndex.value = index;
  for (const key of Object.keys(formState)) delete formState[key];
  for (const f of a.form ?? []) {
    if (isAllowedFieldKind(f.kind)) formState[f.key] = "";
  }
  formOpen.value = true;
}
function submitActionForm() {
  const a = formAction.value;
  if (!a) return;
  const payload: Record<string, unknown> = {};
  for (const f of formFields.value) {
    const raw = formState[f.key] ?? "";
    payload[f.key] = f.kind === "int" ? (toNumber(raw) ?? raw) : raw;
  }
  runAction(formActionIndex.value, a, payload);
}

// An action without a form used to fire straight off the click, including the
// ones a plugin labels "delete" or "revoke". Every form-less action now goes
// through a confirm that names the plugin and the action first.
const confirmTarget = ref<{ index: number; action: PluginViewAction } | undefined>();

function onActionClick(index: number, a: PluginViewAction) {
  if (hasForm(a)) openActionForm(index, a);
  else confirmTarget.value = { index, action: a };
}
function confirmAction() {
  const target = confirmTarget.value;
  if (!target) return;
  runAction(target.index, target.action);
}
</script>

<template>
  <PluginFrameHost
    v-if="kind === 'sandbox' && hasAccess && plugin?.ui_runtime"
    :key="`${plugin.id}:${plugin.ui_runtime.asset_digest}:${viewRoute}:${callableInterfaceFingerprint}`"
    :plugin-id="plugin.id"
    :plugin-name="plugin.name || plugin.id"
    :plugin-version="plugin.version"
    :plugin-route="viewRoute"
    :runtime="plugin.ui_runtime"
    :interfaces="plugin.interfaces ?? []"
  />

  <div v-else class="p-6 space-y-6">
    <PageHeader :title="pageTitle" :section="sectionLabel" :description="$t('pluginViews.providedBy', { plugin: plugin?.name || pluginId })">
      <template v-if="hasSource" #status>
        <FreshnessLabel :last-updated="sourceQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          v-if="hasSource"
          variant="outline"
          size="sm"
          :disabled="sourceQuery.refreshing.value"
          @click="sourceQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', sourceQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <!-- Contributed actions live in the header for data views; the form kind
             surfaces them in its body instead. -->
        <template v-if="view && hasAccess && kind !== 'form'">
          <Button
            v-for="(a, i) in actions"
            :key="`${i}:${a.label}`"
            size="sm"
            :disabled="!canRunAction(a) || runningIndex !== null"
            :title="actionTitle(a)"
            @click="onActionClick(i, a)"
          >
            <RefreshCw v-if="runningIndex === i" class="size-4 animate-spin" aria-hidden="true" />
            <Play v-else class="size-4" aria-hidden="true" />
            {{ a.label }}
          </Button>
        </template>
      </template>
    </PageHeader>

    <!-- Resolving the registry (it may load after mount). -->
    <DataState v-if="!ready" :loading="true" />

    <!-- View not available (plugin deactivated, route gone, or never declared). -->
    <EmptyState
      v-else-if="!view"
      :icon="PackageOpen"
      :title="$t('pluginViews.unavailableTitle')"
      :description="$t('pluginViews.unavailableDescription')"
    />

    <!-- Insufficient scope: a quiet, non-destructive panel (no redirect). -->
    <Card v-else-if="!hasAccess" class="border-border">
      <CardContent class="flex flex-col items-center gap-3 p-8 text-center">
        <div class="flex items-center justify-center rounded-full bg-muted p-3 text-muted-foreground">
          <Lock class="size-5" aria-hidden="true" />
        </div>
        <div class="space-y-1">
          <p class="text-sm font-medium text-foreground">{{ $t('pluginViews.noAccessTitle') }}</p>
          <p class="text-sm text-muted-foreground">{{ $t('pluginViews.noAccessDescription') }}</p>
        </div>
      </CardContent>
    </Card>

    <!-- Unknown/unsupported view kind: inert, not an error. -->
    <EmptyState
      v-else-if="!supportedKind"
      :icon="Puzzle"
      :title="$t('pluginViews.unsupportedTitle')"
      :description="$t('pluginViews.unsupportedDescription')"
    />

    <!-- table (PRIMARY): the proof path, fed by POST /api/plugins/call. -->
    <Card v-else-if="kind === 'table'">
      <CardContent class="pt-6">
        <DataTable
          v-if="hasSource"
          :columns="columns"
          :rows="rows"
          :row-key="keyOf"
          :loading="sourceQuery.loading.value"
          :error="sourceQuery.error.value"
          :page-size="50"
          :searchable="hasSearchableColumn"
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('pluginViews.emptyTitle')"
          :empty-description="$t('pluginViews.emptyDescription')"
          :showing-label="$t('pluginViews.showing')"
          :of-label="$t('pluginViews.of')"
          :page-of-label="$t('pluginViews.of')"
          :prev-label="$t('pluginViews.prevPage')"
          :next-label="$t('pluginViews.nextPage')"
          @retry="sourceQuery.refresh"
        >
          <template
            v-for="col in columns"
            :key="col.key"
            #[cellSlot(col.key)]="{ value }"
          >
            <div
              v-if="renderByKey[col.key] === 'copy-secret'"
              class="flex items-center justify-end gap-2"
            >
              <code
                class="hidden max-w-[180px] truncate font-mono text-xs text-muted-foreground sm:inline"
                :title="$t('pluginViews.secretHidden')"
              >{{ maskSecret(value) }}</code>
              <CopyButton v-if="toText(value)" :value="toText(value)" :label="$t('pluginViews.copy')" />
              <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
            </div>
            <Badge v-else-if="renderByKey[col.key] === 'badge'" variant="outline">
              {{ toText(value) || $t('common.misc.none') }}
            </Badge>
            <code v-else-if="renderByKey[col.key] === 'code'" class="font-mono text-xs">
              {{ toText(value) || $t('common.misc.none') }}
            </code>
            <span v-else-if="renderByKey[col.key] === 'bytes'" class="font-mono text-xs tabular">
              {{ formatBytes(toNumber(value)) }}
            </span>
            <span
              v-else-if="renderByKey[col.key] === 'relative-time'"
              :title="formatDateTime(toText(value))"
            >
              {{ value ? formatRelativeTime(toText(value)) : $t('common.misc.none') }}
            </span>
            <span v-else>{{ toText(value) || $t('common.misc.none') }}</span>
          </template>
        </DataTable>
        <EmptyState
          v-else
          :title="$t('pluginViews.noSourceTitle')"
          :description="$t('pluginViews.noSourceDescription')"
        />
      </CardContent>
    </Card>

    <!-- kv / detail: object → description list. -->
    <Card v-else-if="kind === 'kv' || kind === 'detail'">
      <CardContent class="pt-6">
        <DataState
          :loading="sourceQuery.loading.value"
          :error="sourceQuery.error.value"
          :has-data="sourceQuery.data.value !== undefined"
          :is-empty="kvEntries.length === 0"
          :empty-title="$t('pluginViews.emptyTitle')"
          :empty-description="$t('pluginViews.emptyDescription')"
          @retry="sourceQuery.refresh"
        >
          <dl class="overflow-hidden rounded-md border border-border">
            <div
              v-for="([key, val], idx) in kvEntries"
              :key="key"
              class="flex items-start justify-between gap-4 px-4 py-2.5"
              :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
            >
              <dt class="shrink-0 text-xs font-medium text-muted-foreground">{{ key }}</dt>
              <dd class="min-w-0 break-words text-right font-mono text-sm">{{ toText(val) || $t('common.misc.none') }}</dd>
            </div>
          </dl>
        </DataState>
      </CardContent>
    </Card>

    <!-- markdown: plain text, no new heavy dep, strict CSP holds. -->
    <Card v-else-if="kind === 'markdown'">
      <CardContent class="pt-6">
        <DataState
          :loading="sourceQuery.loading.value"
          :error="sourceQuery.error.value"
          :has-data="sourceQuery.data.value !== undefined"
          :is-empty="hasSource && !markdownText"
          :empty-title="$t('pluginViews.emptyTitle')"
          :empty-description="$t('pluginViews.emptyDescription')"
          @retry="sourceQuery.refresh"
        >
          <pre class="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-4 font-mono text-xs text-foreground">{{ markdownText }}</pre>
        </DataState>
      </CardContent>
    </Card>

    <!-- form: action-driven; each action opens a small text/int/select modal. -->
    <Card v-else-if="kind === 'form'">
      <CardHeader>
        <CardTitle>{{ pageTitle }}</CardTitle>
        <CardDescription>{{ $t('pluginViews.formHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="actions.length" class="flex flex-wrap gap-2">
          <Button
            v-for="(a, i) in actions"
            :key="`${i}:${a.label}`"
            :disabled="!canRunAction(a) || runningIndex !== null"
            :title="actionTitle(a)"
            @click="onActionClick(i, a)"
          >
            <RefreshCw v-if="runningIndex === i" class="size-4 animate-spin" aria-hidden="true" />
            <Play v-else class="size-4" aria-hidden="true" />
            {{ a.label }}
          </Button>
        </div>
        <EmptyState
          v-else
          :icon="Puzzle"
          :title="$t('pluginViews.noActionsTitle')"
          :description="$t('pluginViews.noActionsDescription')"
        />
      </CardContent>
    </Card>

    <!-- Form-less actions confirm first; the plugin and action are named. -->
    <ConfirmDialog
      :open="!!confirmTarget"
      :title="$t('platform.plugins.actionConfirmTitle')"
      :description="confirmTarget
        ? $t('platform.plugins.actionConfirmDescription', {
            action: confirmTarget.action.label,
            plugin: plugin?.name || pluginId,
          })
        : ''"
      :confirm-label="confirmTarget?.action.label ?? $t('common.actions.confirm')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="runningIndex !== null"
      @update:open="(v) => { if (!v) confirmTarget = undefined; }"
      @confirm="confirmAction"
    />

    <!-- Action form modal (text / int / select) -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ formAction?.label }}</DialogTitle>
          <DialogDescription>{{ $t('pluginViews.formModalHint') }}</DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitActionForm">
          <div v-for="field in formFields" :key="field.key" class="grid gap-2">
            <Label :for="`plugin-field-${field.key}`">{{ field.label || field.key }}</Label>
            <Select v-if="field.kind === 'select'" v-model="formState[field.key]">
              <SelectTrigger :id="`plugin-field-${field.key}`">
                <SelectValue :placeholder="$t('pluginViews.selectPlaceholder')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="opt in field.options ?? []" :key="opt" :value="opt">{{ opt }}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-else
              :id="`plugin-field-${field.key}`"
              v-model="formState[field.key]"
              :type="field.kind === 'int' ? 'number' : 'text'"
              autocomplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="formOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="runningIndex !== null">
              <RefreshCw v-if="runningIndex !== null" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ $t('pluginViews.submit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
