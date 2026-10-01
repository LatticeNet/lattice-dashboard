<script setup lang="ts">
/**
 * Plugins (design 23, section 4.5): is each plugin running, at what version,
 * and which pages it adds.
 *
 * One list for every reader. The two tabs split the same four bundles by
 * permission (Registered for audit:read, Lifecycle for plugin:admin); the
 * list now merges whichever reads the session holds (pluginsModel), so a
 * reader without either still sees every active plugin and its pages. A
 * row opens the plugin in the sheet on `?open=`: capabilities, the artifact
 * digest, runtime and transitions, with the lifecycle moves. Disable is a
 * reversible move (design 23, 3.8), so it is never red. Verify manifest is
 * the signing ceremony's tool and sits as a secondary action.
 *
 * The server does not read the plugin index, so whether a newer version
 * exists is not checked; the proof line says so instead of guessing.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Power, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-vue-next";
import { api, type PluginLifecycleStatus, type PluginVerifyResponse } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePluginContributions } from "@/composables/usePluginContributions";
import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { useAuthStore } from "@/stores/auth";
import { formatAge, formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";
import {
  mergePluginRows,
  nextLifecycleStates,
  pluginHealth,
  type PluginHealth,
  type PluginLifecycleTarget,
  type PluginRow,
} from "./pluginsModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const { t, locale } = useI18n();
const auth = useAuthStore();
const canAudit = computed(() => auth.can("audit:read"));
const canAdmin = computed(() => auth.can("plugin:admin"));
const canVerify = computed(() => auth.can("plugin:verify"));

const registeredQuery = useAsyncData((signal) => api.plugins.list({ signal }), {
  pollInterval: 15000,
  immediate: canAudit.value,
});
const lifecycleQuery = useAsyncData((signal) => api.plugins.lifecycle({ signal }), {
  pollInterval: 15000,
  immediate: canAdmin.value,
});
const contributionsQuery = useAsyncData((signal) => api.plugins.contributions(signal), { pollInterval: 15000 });
const { refresh: refreshPluginContributions, removeCachedPlugin } = usePluginContributions();

/** The reads this session holds; the proof line speaks for the weakest of them. */
const reads = computed(() => [
  ...(canAdmin.value ? [lifecycleQuery] : []),
  ...(canAudit.value ? [registeredQuery] : []),
  contributionsQuery,
]);
const proof = useProof([lifecycleQuery, registeredQuery, contributionsQuery].filter((query) => reads.value.includes(query)));

const rows = computed<PluginRow[]>(() =>
  mergePluginRows(registeredQuery.data.value, lifecycleQuery.data.value, contributionsQuery.data.value),
);
const anyRead = computed(() => reads.value.some((query) => query.data.value !== undefined));
/** The table's error: only when no read landed, so a partial answer still lists what it has. */
const tableError = computed(() => (anyRead.value ? null : (reads.value.find((query) => query.error.value)?.error.value ?? null)));

function refreshAll(): void {
  if (canAudit.value) void registeredQuery.refresh();
  if (canAdmin.value) void lifecycleQuery.refresh();
  void contributionsQuery.refresh();
  void refreshPluginContributions();
}

const HEALTH_TONE: Record<PluginHealth, string> = {
  running: "text-muted-foreground",
  failed: "text-destructive",
  missing: "text-destructive",
  stopped: "text-warning-text",
  disabled: "text-muted-foreground",
  pending: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

function healthOf(row: PluginRow): PluginHealth {
  return pluginHealth(row);
}

function healthText(row: PluginRow): string {
  const health = healthOf(row);
  if (health === "unknown" && row.status === "active") return t("platform.pluginsPage.health.active");
  return t(`platform.pluginsPage.health.${health}`);
}

const proofSegments = computed<ProofSegment[]>(() => {
  const n = rows.value.length;
  const parts: ProofSegment[] = [{ key: "plugins", text: t("platform.pluginsPage.proof.plugins", { n }, n) }];
  const count = (health: PluginHealth) => rows.value.filter((row) => healthOf(row) === health).length;
  const active = rows.value.filter((row) => row.status === "active").length;
  parts.push({ key: "active", text: t("platform.pluginsPage.proof.active", { n: active }) });
  const failed = count("failed") + count("missing");
  if (failed) parts.push({ key: "failed", text: t("platform.pluginsPage.proof.failed", { n: failed }), tone: "destructive" });
  const stopped = count("stopped");
  if (stopped) parts.push({ key: "stopped", text: t("platform.pluginsPage.proof.stopped", { n: stopped }), tone: "warning" });
  if (!canAdmin.value) parts.push({ key: "runtime", text: t("platform.pluginsPage.proof.runtimeUnread"), tone: "muted" });
  parts.push({ key: "newer", text: t("platform.pluginsPage.proof.newerUnchecked"), tone: "muted" });
  return parts;
});

const sheet = useRouteOpen();

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const row of rows.value) {
    const health = healthOf(row);
    const open = { label: t("platform.pluginsPage.attention.open"), run: () => sheet.open(row.id) };
    if (health === "failed") {
      items.push({
        key: `failed:${row.id}`,
        tone: "danger",
        claim: t("platform.pluginsPage.attention.failedClaim", { name: row.name }),
        proof: row.runtime?.message ?? t("platform.pluginsPage.attention.noMessage"),
        action: open,
      });
    } else if (health === "missing") {
      items.push({
        key: `missing:${row.id}`,
        tone: "danger",
        claim: t("platform.pluginsPage.attention.missingClaim", { name: row.name }),
        proof: t("platform.pluginsPage.attention.missingProof"),
        action: open,
      });
    } else if (health === "stopped") {
      items.push({
        key: `stopped:${row.id}`,
        tone: "warning",
        claim: t("platform.pluginsPage.attention.stoppedClaim", { name: row.name }),
        proof: row.runtime?.message ?? t("platform.pluginsPage.attention.stoppedProof"),
        action: open,
      });
    } else if (health === "disabled") {
      items.push({
        key: `disabled:${row.id}`,
        tone: "info",
        claim: t("platform.pluginsPage.attention.disabledClaim", { name: row.name }),
        proof: row.transitions.find((entry) => entry.key === "disabled")
          ? t("platform.pluginsPage.attention.disabledSince", { when: formatDateTime(row.transitions.find((entry) => entry.key === "disabled")!.at) })
          : undefined,
        action: open,
      });
    }
  }
  return items;
});

const columns = computed<DataTableColumn<PluginRow>[]>(() => [
  { key: "name", label: t("platform.plugins.colName"), sortable: true, searchable: true, value: (row) => `${row.name} ${row.id}` },
  { key: "version", label: t("platform.plugins.colVersion"), sortable: true, searchable: true, value: (row) => row.version ?? "" },
  { key: "health", label: t("platform.pluginsPage.colState"), sortable: true, value: (row) => healthOf(row) },
  { key: "pages", label: t("platform.pluginsPage.colPages"), searchable: true, value: (row) => row.pages.map((page) => page.title).join(" ") },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const openRow = computed(() => rows.value.find((row) => row.id === sheet.openId.value));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openRow.value) return proof.value.state === "stale" ? ("stale" as const) : ("ready" as const);
  if (!anyRead.value) return proof.value.state === "failed" ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

function ago(at: string | undefined): string {
  if (!at) return "";
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? "" : formatAge(Date.now() - ms, locale.value);
}

/* ------------------------------------------------------------------ */
/* Lifecycle moves                                                     */
/* ------------------------------------------------------------------ */

function transitionLabel(status: PluginLifecycleTarget): string {
  switch (status) {
    case "installed":
      return t("platform.plugins.install");
    case "active":
      return t("platform.plugins.activate");
    case "disabled":
      return t("common.actions.disable");
  }
}

function menuFor(row: PluginRow): RowMenuItem[] {
  const pages = row.pages.map((page) => ({ key: `page:${page.route}`, label: t("platform.pluginsPage.openPage", { page: page.title }), to: page.to }));
  const moves = canAdmin.value && row.lifecycleRead
    ? nextLifecycleStates(row.status).map((status) => ({
        key: `move:${status}`,
        label: transitionLabel(status),
        icon: Power,
        run: () => requestTransition(row, status),
      }))
    : [];
  return [...pages, ...moves];
}

const transitionTarget = ref<{ row: PluginRow; status: PluginLifecycleTarget } | undefined>(undefined);
const transitioning = ref(false);

function requestTransition(row: PluginRow, status: PluginLifecycleTarget) {
  transitionTarget.value = { row, status };
}

const transitionImpact = computed(() => {
  const target = transitionTarget.value;
  if (!target) return [];
  if (target.status === "disabled") {
    const lines = [t("platform.pluginsPage.disable.runtime", { name: target.row.name })];
    if (target.row.pages.length) lines.push(t("platform.pluginsPage.disable.pages", { pages: target.row.pages.map((page) => page.title).join(", ") }));
    lines.push(t("platform.pluginsPage.disable.calls"));
    return lines;
  }
  return [];
});

async function confirmTransition() {
  if (!transitionTarget.value) return;
  const { row, status } = transitionTarget.value;
  transitioning.value = true;
  try {
    await api.plugins.setLifecycle(row.id, status as PluginLifecycleStatus);
    if (status === "disabled") removeCachedPlugin(row.id);
    await Promise.all([
      canAdmin.value ? lifecycleQuery.refresh() : Promise.resolve(),
      refreshPluginContributions(),
      contributionsQuery.refresh(),
      canAudit.value ? registeredQuery.refresh() : Promise.resolve(),
    ]);
    toast.success(t("platform.plugins.transitionDone", { name: row.name, status }));
    transitionTarget.value = undefined;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.plugins.transitionFailed"));
  } finally {
    transitioning.value = false;
  }
}

// ── Verify dialog (plugin:verify) ───────────────────────────────────────────
const verifyOpen = ref(false);
const verifying = ref(false);
const manifestText = ref("");
const artifactText = ref("");
const verifyResult = ref<PluginVerifyResponse | undefined>(undefined);

function openVerify() {
  manifestText.value = "";
  artifactText.value = "";
  verifyResult.value = undefined;
  verifyOpen.value = true;
}

function riskVariant(risk: string): "secondary" | "warning" | "destructive" | "outline" {
  switch (risk) {
    case "read":
      return "secondary";
    case "write":
      return "warning";
    case "host":
      return "destructive";
    default:
      return "outline";
  }
}

async function runVerify() {
  if (!canVerify.value) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText.value);
  } catch {
    toast.error(t("platform.plugins.manifestInvalidJson"));
    return;
  }
  verifying.value = true;
  verifyResult.value = undefined;
  try {
    verifyResult.value = await api.plugins.verify(manifest, artifactText.value.trim());
    toast.success(t("platform.plugins.manifestVerified"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.plugins.verificationFailed"));
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.plugins.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.pluginsPage.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="proof.state === 'refreshing'" @click="refreshAll">
          <RefreshCw aria-hidden="true" :class="cn('size-4', proof.state === 'refreshing' && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canVerify" variant="ghost" size="sm" @click="openVerify">
          <ShieldCheck aria-hidden="true" class="size-4" />
          {{ $t('platform.plugins.verifyManifest') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <DataTable
      state-key="plugins"
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="!anyRead && proof.state === 'loading'"
      :error="tableError"
      :has-data="anyRead"
      :searchable="rows.length > 6"
      :expression-filter="false"
      :row-click="(row, el) => sheet.open(row.id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="$t('platform.plugins.registeredEmptyTitle')"
      :empty-description="$t('platform.plugins.registeredEmptyDescription')"
      @retry="refreshAll"
    >
      <template #cell-name="{ row }">
        <div class="font-medium">{{ row.name }}</div>
        <div class="font-mono text-xs text-muted-foreground">{{ row.id }}</div>
      </template>
      <template #cell-version="{ row }">
        <span class="whitespace-nowrap font-mono text-xs">{{ row.version || $t('common.misc.none') }}</span>
      </template>
      <template #cell-health="{ row }">
        <span :class="cn('whitespace-nowrap text-xs', HEALTH_TONE[healthOf(row)])">{{ healthText(row) }}</span>
        <span v-if="healthOf(row) === 'running' && row.runtime?.started_at" class="block text-xs text-muted-foreground" :title="formatDateTime(row.runtime.started_at)">
          {{ $t('platform.pluginsPage.since', { age: ago(row.runtime.started_at) }) }}
        </span>
      </template>
      <template #cell-pages="{ row }">
        <div v-if="row.pages.length" class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          <RouterLink v-for="page in row.pages" :key="page.route" :to="page.to" class="whitespace-nowrap text-primary underline-offset-4 hover:underline" @click.stop>
            {{ page.title }}
          </RouterLink>
        </div>
        <span v-else class="text-xs text-muted-foreground">{{ row.status === 'active' ? $t('platform.pluginsPage.noPages') : $t('platform.pluginsPage.pagesWhenActive') }}</span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu v-if="menuFor(row).length" :name="row.name" :items="menuFor(row)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openRow ? openRow.name : (sheet.openId.value ?? '')"
      :subtitle="openRow ? `${openRow.id}${openRow.version ? ` · ${openRow.version}` : ''}` : undefined"
      :state="sheetState"
      :error="proof.error"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('platform.pluginsPage.goneTitle')"
      :gone-description="$t('platform.pluginsPage.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openRow" class="space-y-5 text-sm">
        <p :class="HEALTH_TONE[healthOf(openRow)] === 'text-muted-foreground' ? 'text-foreground' : HEALTH_TONE[healthOf(openRow)]">
          {{ healthText(openRow) }}<span v-if="openRow.runtime?.runner" class="text-muted-foreground"> · {{ $t('platform.pluginsPage.sheet.runner', { runner: openRow.runtime.runner }) }}</span>
        </p>
        <pre
          v-if="openRow.runtime?.message"
          class="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground"
        >{{ openRow.runtime.message }}</pre>
        <p v-if="!openRow.lifecycleRead" class="text-xs text-muted-foreground">{{ $t('platform.pluginsPage.sheet.lifecycleUnread') }}</p>

        <section v-if="openRow.pages.length" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.pluginsPage.colPages') }}</h3>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <RouterLink v-for="page in openRow.pages" :key="page.route" :to="page.to" class="text-primary underline-offset-4 hover:underline">{{ page.title }}</RouterLink>
          </div>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.plugins.colCapabilities') }}</h3>
          <div v-if="openRow.capabilities.length" class="flex flex-wrap gap-1.5">
            <Badge v-for="cap in openRow.capabilities" :key="cap" variant="outline" class="font-mono">{{ cap }}</Badge>
          </div>
          <p v-else class="text-xs text-muted-foreground">{{ $t('platform.plugins.noneDeclared') }}</p>
        </section>

        <section v-if="openRow.lifecycleRead" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.plugins.artifactSha256') }}</h3>
          <div v-if="openRow.artifactSha256" class="flex items-start gap-1">
            <code class="min-w-0 break-all font-mono text-xs">{{ openRow.artifactSha256 }}</code>
            <CopyButton :value="openRow.artifactSha256" />
          </div>
          <p v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</p>
          <p v-if="openRow.available === false" class="text-xs text-destructive">{{ $t('platform.pluginsPage.attention.missingProof') }}</p>
        </section>

        <section v-if="openRow.transitions.length" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.pluginsPage.sheet.transitions') }}</h3>
          <ol class="divide-y divide-border rounded-md border border-border">
            <li v-for="entry in openRow.transitions" :key="entry.key" class="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-xs">
              <span class="text-foreground">{{ $t(`platform.pluginsPage.transition.${entry.key}`) }}</span>
              <span class="text-muted-foreground" :title="formatDateTime(entry.at)">{{ formatDateTime(entry.at) }}</span>
            </li>
          </ol>
        </section>

        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div v-if="openRow.publisher">
            <dt class="text-xs text-muted-foreground">{{ $t('platform.plugins.colPublisher') }}</dt>
            <dd>{{ openRow.publisher }}</dd>
          </div>
          <div v-if="openRow.type">
            <dt class="text-xs text-muted-foreground">{{ $t('platform.plugins.colType') }}</dt>
            <dd>{{ openRow.type }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('platform.pluginsPage.sheet.newer') }}</dt>
            <dd class="text-muted-foreground">{{ $t('platform.pluginsPage.sheet.newerUnchecked') }}</dd>
          </div>
        </dl>
      </div>
      <template v-if="openRow && canAdmin && openRow.lifecycleRead && nextLifecycleStates(openRow.status).length" #actions>
        <Button
          v-for="status in nextLifecycleStates(openRow.status)"
          :key="status"
          variant="outline"
          size="sm"
          type="button"
          @click="requestTransition(openRow, status)"
        >
          <Power aria-hidden="true" />
          {{ transitionLabel(status) }}
        </Button>
      </template>
    </ObjectSheet>

    <!-- A lifecycle move is reversible (design 23, 3.8): never filled red. Disable names what stops. -->
    <ConfirmDialog
      :open="!!transitionTarget"
      variant="default"
      :title="transitionTarget ? $t(`platform.pluginsPage.confirm.${transitionTarget.status}`, { name: transitionTarget.row.name }) : ''"
      :description="transitionTarget?.status === 'active' ? $t('platform.plugins.activatingStarts') : transitionTarget?.status === 'installed' ? $t('platform.pluginsPage.confirm.installDescription') : undefined"
      :impact="transitionImpact.length ? transitionImpact : undefined"
      :impact-title="$t('platform.pluginsPage.disable.title')"
      :confirm-label="transitionTarget ? transitionLabel(transitionTarget.status) : $t('common.actions.confirm')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="transitioning"
      @update:open="(v) => { if (!v) transitionTarget = undefined; }"
      @confirm="confirmTransition"
    />

    <!-- Verify dialog -->
    <Dialog v-model:open="verifyOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.plugins.verifyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.plugins.verifyHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="runVerify">
          <div class="grid gap-2">
            <Label for="verify-manifest">{{ $t('platform.plugins.manifestLabel') }}</Label>
            <Textarea
              id="verify-manifest"
              v-model="manifestText"
              rows="8"
              spellcheck="false"
              placeholder='{"id":"...","name":"...","type":"wasm","capabilities":[]}'

             class="font-mono text-xs"
           />
          </div>
          <div class="grid gap-2">
            <Label for="verify-artifact">{{ $t('platform.plugins.artifactLabel') }}</Label>
            <Textarea
              id="verify-artifact"
              v-model="artifactText"
              rows="4"
              spellcheck="false"
              :placeholder="$t('platform.plugins.artifactPlaceholder')"

             class="font-mono text-xs"
           />
            <p class="text-xs text-muted-foreground">{{ $t('platform.plugins.verifyBothRequired') }}</p>
          </div>

          <!--
            The verify endpoint hard-codes trusted:true on its success path and
            returns an HTTP error otherwise, so `verifyResult.trusted` says
            nothing an operator can act on. What it does say is whether a
            signing key was checked: VerifyManifest only reaches the signature
            branch when the manifest names a publisher, so a publisher on an
            accepted manifest means a trusted publisher's signature verified,
            and no publisher means no key was checked at all.
          -->
          <div
            v-if="verifyResult"
            :class="cn(
              'space-y-4 rounded-md border p-4',
              verifyResult.manifest.publisher ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5',
            )"
          >
            <div class="flex flex-wrap items-center gap-2">
              <Badge :variant="verifyResult.manifest.publisher ? 'success' : 'warning'" class="gap-1.5">
                <ShieldCheck v-if="verifyResult.manifest.publisher" aria-hidden="true" class="size-3.5" />
                <ShieldAlert v-else aria-hidden="true" class="size-3.5" />
                {{
                  verifyResult.manifest.publisher
                    ? $t('platform.plugins.signedBy', { publisher: verifyResult.manifest.publisher })
                    : $t('platform.plugins.unsigned')
                }}
              </Badge>
              <Badge variant="outline">{{ verifyResult.manifest.type }}</Badge>
              <span class="text-sm font-medium">{{ verifyResult.manifest.name || verifyResult.manifest.id }}</span>
            </div>

            <div class="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.manifestId') }}</p>
                <p class="mt-1 break-all font-mono">{{ verifyResult.manifest.id }}</p>
              </div>
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.versionPublisher') }}</p>
                <p class="mt-1 font-mono">{{ verifyResult.manifest.version || $t('common.misc.none') }} · {{ verifyResult.manifest.publisher || $t('common.misc.none') }}</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
              <span class="font-medium">{{ $t('platform.plugins.artifactSha256') }}</span>
              <code class="break-all font-mono">{{ verifyResult.artifact_sha256 }}</code>
              <CopyButton :value="verifyResult.artifact_sha256" />
            </div>

            <div class="space-y-2">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.colCapabilities') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <Badge
                  v-for="cap in verifyResult.capabilities"
                  :key="cap.name"
                  :variant="riskVariant(cap.risk)"
                  class="gap-1 font-mono"
                >
                  {{ cap.name }}
                  <span class="opacity-70">({{ cap.risk }})</span>
                </Badge>
                <span v-if="!verifyResult.capabilities.length" class="text-xs text-muted-foreground">{{ $t('platform.plugins.noneDeclared') }}</span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="verifyOpen = false">{{ $t('common.actions.close') }}</Button>
            <Button type="submit" :disabled="verifying || !manifestText.trim() || !artifactText.trim()">
              <RefreshCw v-if="verifying" aria-hidden="true" class="size-4 animate-spin" />
              <ShieldCheck v-else aria-hidden="true" class="size-4" />
              {{ $t('common.actions.verify') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
