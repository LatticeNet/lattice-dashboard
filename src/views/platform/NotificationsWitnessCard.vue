<script setup lang="ts">
/*
 * The control-plane witness on Notifications (design: lane deadman, Gate 1 in
 * the lane log). One card on the Routing layer: per witness node, one
 * sentence for what it sees and since when, its last push, where it pushes,
 * whether it runs the approved config, and any plan in flight. The guided
 * action files a plan; nothing changes on a node until the approval is
 * decided, which is the product's rule for every privileged change.
 */
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { OctagonAlert, Pencil, Plus, Radar, RefreshCw, Trash2, TriangleAlert } from "lucide-vue-next";

import { api, type NotifyChannelView, type WitnessNodeView, type WitnessStatusResponse } from "@/lib/api";
import { toast } from "@/lib/toast";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  barkChannels,
  witnessConfigState,
  witnessFormDefaults,
  witnessFormProblems,
  witnessLine,
  witnessPlanRequest,
  witnessPushLine,
  type WitnessForm,
  type WitnessFormProblem,
  type WitnessLine,
} from "./witnessModel";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const props = defineProps<{
  status?: WitnessStatusResponse;
  loading: boolean;
  error?: unknown;
  channels: NotifyChannelView[];
  canManage: boolean;
}>();
const emit = defineEmits<{ refresh: []; filed: [] }>();

const { t, te } = useI18n();

/** A Bark interruption level as the rule editor's select offers it; a level without copy keeps its name. */
function levelLabel(level: string): string {
  const key = `platform.notifications.incidents.levels.${level}`;
  return te(key) ? t(key) : level;
}

const nodes = computed(() => props.status?.nodes ?? []);
/** Nodes worth a block: a witness applied, waiting, failed, or still reporting. */
const shownNodes = computed(() => nodes.value.filter((node) => node.configured || node.pending || node.last_failed || (node.report && node.report_fresh)));

function lineText(line: WitnessLine): string {
  const when = line.at ? formatRelativeTime(line.at) : "";
  const since = line.since ? formatDateTime(line.since) : "";
  const detail = line.detail || t("platform.notifications.witness.push.refusedNoReason");
  switch (line.key) {
    case "failing":
      return t("platform.notifications.witness.line.failing", { since, n: line.failures ?? 0, detail }, line.failures ?? 0);
    default:
      return t(`platform.notifications.witness.line.${line.key}`, { when, since });
  }
}

function pushText(node: WitnessNodeView): string {
  const push = witnessPushLine(node.report);
  if (!push || push.key === "none") return t("platform.notifications.witness.push.none");
  const result = push.ok
    ? t("platform.notifications.witness.push.accepted")
    : push.error
      ? t("platform.notifications.witness.push.refused", { error: push.error })
      : t("platform.notifications.witness.push.refusedNoReason");
  const text = t(`platform.notifications.witness.push.${push.key}`, { result, when: push.at ? formatRelativeTime(push.at) : "" });
  return push.pushes > 0 ? `${text} · ${t("platform.notifications.witness.push.count", { n: push.pushes }, push.pushes)}` : text;
}

function pushFailed(node: WitnessNodeView): boolean {
  const push = witnessPushLine(node.report);
  return !!push && push.key !== "none" && !push.ok;
}

function planText(node: WitnessNodeView): string | undefined {
  const pending = node.pending;
  if (pending) {
    if (pending.action === "remove") return t("platform.notifications.witness.plan.removePending");
    return pending.status === "approved" ? t("platform.notifications.witness.plan.approved") : t("platform.notifications.witness.plan.pending");
  }
  if (node.last_failed) return t("platform.notifications.witness.plan.failed", { reason: node.last_failed.reason ?? "" });
  return undefined;
}

function planApprovalId(node: WitnessNodeView): string | undefined {
  return node.pending?.approval_id ?? node.last_failed?.approval_id;
}

function menu(node: WitnessNodeView): RowMenuItem[] {
  const items: RowMenuItem[] = [{ key: "change", label: t("platform.notifications.witness.change"), icon: Pencil, run: () => openForm(node) }];
  if (node.configured) items.push({ key: "remove", label: t("platform.notifications.witness.remove"), icon: Trash2, danger: true, run: () => (removeTarget.value = node) });
  return items;
}

const TONE_TEXT = { muted: "text-muted-foreground", warning: "text-warning-text", danger: "text-destructive" } as const;

// ── Setup and change ────────────────────────────────────────────────────────

const formOpen = ref(false);
const changing = ref<WitnessNodeView | undefined>();
const form = ref<WitnessForm>({ nodeId: "", channelId: "", barkUrl: "", barkLevel: "critical", references: "", interval: "30", hold: "180", recover: "60" });
const touched = ref(false);
const filing = ref(false);

const bark = computed(() => barkChannels(props.channels));
const capable = computed(() => props.status?.capable_nodes ?? []);
/** A change keeps its node even when that node's agent stopped advertising witness mode, so the form can say why it will be refused. */
const nodeChoices = computed(() => {
  const list = [...capable.value];
  const current = changing.value;
  if (current && !list.some((n) => n.node_id === current.node_id)) list.push({ node_id: current.node_id, node_name: current.node_name, online: false });
  return list;
});
const problems = computed(() => witnessFormProblems(form.value));
const blocked = computed(() => !props.status?.health_url || problems.value.length > 0);

function openForm(node?: WitnessNodeView): void {
  if (!props.canManage || !props.status) return;
  changing.value = node;
  form.value = witnessFormDefaults(props.status, props.channels, node);
  touched.value = false;
  formOpen.value = true;
}

function problemText(p: WitnessFormProblem): string {
  return t(`platform.notifications.witness.form.problems.${p}`);
}

function nodeName(id: string): string {
  return nodeChoices.value.find((n) => n.node_id === id)?.node_name ?? id;
}

/** The field each problem is about, in the form's order (witnessFormProblems lists them in that order). */
const PROBLEM_FIELD: Record<WitnessFormProblem, string> = {
  node: "witness-node",
  channel: "witness-channel",
  barkUrl: "witness-bark-url",
  barkUrlLoopback: "witness-bark-url",
  references: "witness-refs",
  interval: "witness-interval",
  hold: "witness-hold",
  recover: "witness-recover",
};

/**
 * A refused submit sends focus to the first field that needs fixing. It fell
 * to the page before: Submit turns disabled under focus once the problems show.
 */
async function focusFirstProblem(): Promise<void> {
  // The timing section opens itself for its own problems on this render.
  await nextTick();
  for (const problem of problems.value) {
    const field = document.getElementById(PROBLEM_FIELD[problem]);
    if (field) {
      field.focus();
      return;
    }
  }
}

async function submit(): Promise<void> {
  touched.value = true;
  if (filing.value) return;
  if (blocked.value) {
    await focusFirstProblem();
    return;
  }
  filing.value = true;
  try {
    await api.notify.planWitness(witnessPlanRequest(form.value));
    toast.success(t("platform.notifications.witness.form.filed", { node: nodeName(form.value.nodeId) }));
    formOpen.value = false;
    emit("filed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.witness.form.failed"));
  } finally {
    filing.value = false;
  }
}

// ── Remove ──────────────────────────────────────────────────────────────────

const removeTarget = ref<WitnessNodeView | undefined>();
const removing = ref(false);

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value;
  if (!target) return;
  removing.value = true;
  try {
    await api.notify.planWitness({ node_id: target.node_id, remove: true });
    toast.success(t("platform.notifications.witness.removeDialog.filed", { node: target.node_name }));
    removeTarget.value = undefined;
    emit("filed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.witness.form.failed"));
  } finally {
    removing.value = false;
  }
}

defineExpose({ openForm });
</script>

<template>
  <Card data-testid="witness-card">
    <CardHeader>
      <div class="min-w-0 space-y-1.5">
          <CardTitle class="flex items-center gap-2">
            <Radar aria-hidden="true" class="size-4 text-muted-foreground" />
            {{ $t('platform.notifications.witness.title') }}
          </CardTitle>
          <CardDescription>{{ $t('platform.notifications.witness.description') }}</CardDescription>
          <p v-if="status?.health_url" class="break-all font-mono text-xs text-muted-foreground" data-testid="witness-watches">
            {{ $t('platform.notifications.witness.watches', { url: status.health_url }) }}
          </p>
          <p v-else-if="status?.health_url_error" class="flex items-start gap-1.5 text-xs text-warning-text">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ $t('platform.notifications.witness.noPublicUrl') }}</span>
          </p>
      </div>
    </CardHeader>
    <CardContent>
      <div v-if="!status && loading" class="h-16 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
      <div v-else-if="!status" class="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>{{ $t('platform.notifications.witness.unread') }}</span>
        <Button variant="outline" size="sm" @click="emit('refresh')">
          <RefreshCw aria-hidden="true" class="size-4" />
          {{ $t('common.actions.retry') }}
        </Button>
      </div>

      <div v-else-if="shownNodes.length === 0" class="flex flex-col gap-3 rounded-md border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="witness-empty">
        <div class="min-w-0">
          <p class="text-sm font-medium">{{ $t('platform.notifications.witness.emptyTitle') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ $t('platform.notifications.witness.emptyBody') }}</p>
        </div>
        <Button v-if="canManage" size="sm" class="shrink-0 self-start sm:self-center" :disabled="!status.health_url" @click="openForm()">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.notifications.witness.setup') }}
        </Button>
      </div>

      <ul v-else class="divide-y divide-border rounded-md border border-border">
        <li v-for="node in shownNodes" :key="node.node_id" class="space-y-2 px-3.5 py-3" data-testid="witness-node" :data-line="witnessLine(node).key">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium" :title="node.node_name">{{ node.node_name }}</p>
              <p :class="cn('mt-0.5 flex items-start gap-1.5 text-sm', TONE_TEXT[witnessLine(node).tone])" data-testid="witness-line">
                <OctagonAlert v-if="witnessLine(node).tone === 'danger'" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <TriangleAlert v-else-if="witnessLine(node).tone === 'warning'" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{{ lineText(witnessLine(node)) }}</span>
              </p>
            </div>
            <RowMenu v-if="canManage" :name="node.node_name" :items="menu(node)" />
          </div>
          <dl class="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
            <template v-if="node.report">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.witness.push.label') }}</dt>
              <dd :class="cn('break-words max-sm:mb-1', pushFailed(node) ? 'text-warning-text' : 'text-foreground')">{{ pushText(node) }}</dd>
            </template>
            <template v-if="node.configured">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.witness.pushesTo.label') }}</dt>
              <dd class="break-words max-sm:mb-1">
                {{ $t('platform.notifications.witness.pushesTo.value', { channel: node.configured.channel_name || node.configured.channel_id || '-', prefix: node.configured.key_sha256_prefix || '-' }) }}
              </dd>
              <dt class="text-muted-foreground">{{ $t('platform.notifications.witness.config.label') }}</dt>
              <dd :class="cn('break-words max-sm:mb-1', witnessConfigState(node) === 'differs' ? 'text-warning-text' : witnessConfigState(node) === 'unknown' ? 'text-muted-foreground' : 'text-foreground')">
                {{ $t(`platform.notifications.witness.config.${witnessConfigState(node)}`) }}
              </dd>
            </template>
            <template v-if="planText(node)">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.witness.plan.label') }}</dt>
              <dd :class="cn('break-words', node.pending ? 'text-foreground' : 'text-warning-text')" data-testid="witness-plan">
                {{ planText(node) }}
                <RouterLink
                  v-if="planApprovalId(node)"
                  :to="{ name: 'approvals', query: { open: planApprovalId(node) } }"
                  class="ml-1 rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:py-1"
                >{{ $t('platform.notifications.witness.plan.review') }}</RouterLink>
              </dd>
            </template>
          </dl>
        </li>
      </ul>
    </CardContent>
  </Card>

  <Dialog v-model:open="formOpen">
    <DialogScrollContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ changing ? $t('platform.notifications.witness.form.changeTitle') : $t('platform.notifications.witness.form.title') }}</DialogTitle>
        <DialogDescription>{{ $t('platform.notifications.witness.form.hint') }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-4" data-testid="witness-form" @submit.prevent="submit">
        <div class="grid gap-1">
          <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.notifications.witness.form.watches') }}</p>
          <p v-if="status?.health_url" class="break-all font-mono text-xs">{{ status.health_url }}</p>
          <p v-else class="text-xs text-warning-text">{{ $t('platform.notifications.witness.noPublicUrl') }}</p>
        </div>

        <div class="grid min-w-0 gap-2">
          <Label for="witness-node">{{ $t('platform.notifications.witness.form.node') }}</Label>
          <Select v-if="nodeChoices.length > 0" v-model="form.nodeId" :disabled="!!changing">
            <SelectTrigger id="witness-node" class="min-w-0 pointer-coarse:h-11" data-testid="witness-node-select">
              <SelectValue class="min-w-0 overflow-hidden" :placeholder="$t('platform.notifications.witness.form.node')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="choice in nodeChoices" :key="choice.node_id" :value="choice.node_id">
                {{ choice.node_name }}<span v-if="!choice.online" class="text-muted-foreground"> · {{ $t('platform.notifications.witness.form.offline') }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-else class="text-sm text-warning-text" data-testid="witness-no-capable">{{ $t('platform.notifications.witness.form.noCapable') }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.witness.form.nodeHint') }}</p>
          <p v-if="touched && problems.includes('node')" class="text-xs text-destructive">{{ problemText('node') }}</p>
        </div>

        <div class="grid min-w-0 gap-2">
          <Label for="witness-channel">{{ $t('platform.notifications.witness.form.channel') }}</Label>
          <Select v-if="bark.length > 0" v-model="form.channelId">
            <SelectTrigger id="witness-channel" class="min-w-0 pointer-coarse:h-11" data-testid="witness-channel-select">
              <SelectValue class="min-w-0 overflow-hidden" :placeholder="$t('platform.notifications.witness.form.channel')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="channel in bark" :key="channel.id" :value="channel.id">{{ channel.name || channel.id }}</SelectItem>
            </SelectContent>
          </Select>
          <p v-else class="text-sm text-warning-text">{{ $t('platform.notifications.witness.form.noBark') }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.witness.form.channelHint') }}</p>
          <p v-if="touched && problems.includes('channel')" class="text-xs text-destructive">{{ problemText('channel') }}</p>
        </div>

        <div class="grid min-w-0 gap-2">
          <Label for="witness-bark-url">{{ $t('platform.notifications.witness.form.barkUrl') }}</Label>
          <Input id="witness-bark-url" v-model="form.barkUrl" class="font-mono pointer-coarse:h-11 sm:w-80" placeholder="http://127.0.0.1:8080" autocomplete="off" inputmode="url" data-testid="witness-bark-url" />
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.witness.form.barkUrlHint') }}</p>
          <p v-if="touched && (problems.includes('barkUrl') || problems.includes('barkUrlLoopback'))" class="text-xs text-destructive">
            {{ problemText(problems.includes('barkUrl') ? 'barkUrl' : 'barkUrlLoopback') }}
          </p>
        </div>

        <div class="grid min-w-0 gap-2">
          <Label for="witness-level">{{ $t('platform.notifications.witness.form.level') }}</Label>
          <Select v-model="form.barkLevel">
            <SelectTrigger id="witness-level" class="min-w-0 pointer-coarse:h-11 sm:w-80">
              <SelectValue class="min-w-0 overflow-hidden" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="level in status?.defaults.bark_levels ?? []" :key="level" :value="level">{{ levelLabel(level) }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.witness.form.levelHint') }}</p>
        </div>

        <details class="group rounded-md border border-border" :open="touched && (problems.includes('references') || problems.includes('interval') || problems.includes('hold') || problems.includes('recover'))">
          <summary class="cursor-pointer select-none rounded-md px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:py-3">
            {{ $t('platform.notifications.witness.form.timing') }}
          </summary>
          <div class="space-y-3 border-t border-border p-3">
            <div class="grid gap-2">
              <Label for="witness-refs">{{ $t('platform.notifications.witness.form.references') }}</Label>
              <textarea
                id="witness-refs"
                v-model="form.references"
                rows="3"
                class="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                spellcheck="false"
              />
              <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.witness.form.referencesHint') }}</p>
              <p v-if="touched && problems.includes('references')" class="text-xs text-destructive">{{ problemText('references') }}</p>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div v-for="key in (['interval', 'hold', 'recover'] as const)" :key="key" class="grid min-w-0 gap-2">
                <Label :for="`witness-${key}`">{{ $t(`platform.notifications.witness.form.${key}`) }}</Label>
                <Input :id="`witness-${key}`" v-model="form[key]" class="tabular pointer-coarse:h-11" inputmode="numeric" autocomplete="off" />
                <p v-if="touched && problems.includes(key)" class="text-xs text-destructive">{{ problemText(key) }}</p>
              </div>
            </div>
          </div>
        </details>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="submit" :disabled="filing || !status?.health_url || (touched && problems.length > 0)" data-testid="witness-submit">
            <RefreshCw v-if="filing" aria-hidden="true" class="size-4 animate-spin" />
            <Radar v-else aria-hidden="true" class="size-4" />
            {{ $t('platform.notifications.witness.form.submit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogScrollContent>
  </Dialog>

  <ConfirmDialog
    :open="!!removeTarget"
    :title="$t('platform.notifications.witness.removeDialog.title')"
    :description="$t('platform.notifications.witness.removeDialog.body', { node: removeTarget?.node_name ?? '' })"
    :confirm-label="$t('platform.notifications.witness.removeDialog.confirm')"
    :cancel-label="$t('common.actions.cancel')"
    :pending="removing"
    @update:open="(v) => { if (!v) removeTarget = undefined; }"
    @confirm="confirmRemove"
  />
</template>
