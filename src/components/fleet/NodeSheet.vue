<script setup lang="ts">
/**
 * One node, opened from a collection (design 23, 4.2): its status and why,
 * what runs or waits on it, its lines, its SSH posture, and its page.
 *
 *   ● offline for 6d        last report 09-24 03:10
 *   No report since the agent went quiet; ...
 *   Its renewal on 2026-09-26 passed before it went quiet; ...
 *   Tasks   1 stalled · 0 running · 0 queued       [Tasks]
 *   SSH     password open                           [SSH Guard]
 *   Lines   on vpn-core                             [Lines]
 *   Machine DMIT · US, Los Angeles
 *           2026-09-26 · 7d overdue    [Provider console] [Inventory]
 *
 * Nodes, Map and Groups open the same sheet on `?open=<node id>`, so a node
 * reads the same wherever it is opened. The page passes its node list and
 * the actions it allows (RowMenu items); the sheet reads the tasks and the
 * SSH posture of the open node only, once per opening and when asked.
 *
 * The machine row comes from the list Inventory reads (one row per node the
 * principal holds inventory:read for), read when the sheet first opens and
 * again after a minute, so stepping through nodes does not re-read it per
 * node. A node the list has no row for is read again before the row says
 * "no access" only when the page did not list it as the read started, since
 * only such a node may have enrolled after the read (machinesNeedRead). The
 * provider console link is sealed on the server and revealed per step-up
 * grant, as on Inventory (useMachineLinkReveal).
 *
 * What the sheet read belongs to the principal signed in when it mounted,
 * and so do the scope checks below, taken once. A principal is applied only
 * by signing in, on /login, which renders outside AppLayout
 * (router/index.ts), or by Security's re-read of the session after TOTP
 * activation, on its own page; either way the page holding this sheet has
 * unmounted first. Sign-out and an expired session leave the shell for
 * /login too (router/expiredSession.ts).
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { ExternalLink, RefreshCw, SquareTerminal } from "lucide-vue-next";

import { api, unwrap, type MachineView, type Node, type SSHGuardNodeStatus, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMachineLinkReveal } from "@/composables/useMachineLinkReveal";
import { usePluginContributions } from "@/composables/usePluginContributions";
import { formatAge, formatDateTime, formatRelativeTime, isZeroTime } from "@/lib/format";
import { describeNodeStatus, isReporting, nodeStatus, nodeStatusReason, nodeStatusSince } from "@/lib/nodeStatus";
import { useAuthStore } from "@/stores/auth";
import { buildNodeQueue } from "@/views/fleet/nodeTaskQueueModel";
import { consoleAction, likelyUnpaid, machinesNeedRead, nodeMachine, type MachinesRead, type RenewalState } from "@/views/fleet/nodeMachineModel";
import { proofReason } from "@/components/common/proofModel";

import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import MachineLinkStepUpDialog from "@/components/fleet/MachineLinkStepUpDialog.vue";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    /** The open node's id, from the page's useRouteOpen. */
    nodeId: string | null;
    /** The page's node list; undefined until it lands. */
    nodes: readonly Node[] | undefined;
    /**
     * Why the page's last read failed. With a list in hand the sheet shows it
     * as stale; with none it says the read failed and offers Retry. The page
     * passes null while a retry is in flight, so the sheet shows it loading.
     */
    error?: string | null;
    returnFocus?: () => HTMLElement | null;
    /** The actions the page allows on this node. */
    menuItems?: RowMenuItem[];
  }>(),
  { error: null, returnFocus: undefined, menuItems: () => [] },
);

const emit = defineEmits<{ close: []; terminal: [node: Node]; retry: [] }>();

const { t, locale } = useI18n();
const auth = useAuthStore();
const plugins = usePluginContributions();

const node = computed(() => (props.nodeId ? props.nodes?.find((entry) => entry.id === props.nodeId) : undefined));
const state = computed(() => {
  if (!props.nodeId) return "loading" as const;
  if (props.nodes === undefined) return props.error ? ("failed" as const) : ("loading" as const);
  if (!node.value) return "gone" as const;
  return props.error ? ("stale" as const) : ("ready" as const);
});

const canTasks = auth.can("task:read");
const canGuard = auth.can("sshguard:read") || auth.can("sshguard:admin");
const canInventory = auth.can("inventory:read");
const canRevealLinks = auth.can("inventory:admin");

const tasks = useAsyncData<TaskView[]>(
  (signal) => api.tasks.listForNode(props.nodeId ?? "", 50, { signal }).then((r) => unwrap(r, "tasks")),
  { immediate: false },
);
const guard = useAsyncData<SSHGuardNodeStatus | undefined>(
  (signal) =>
    api.sshGuard.status([props.nodeId ?? ""], { signal }).then((r) => r.node ?? r.nodes.find((entry) => entry.node_id === props.nodeId)),
  { immediate: false },
);

let machinesRead: MachinesRead = { at: 0, listed: new Set() };
const machines = useAsyncData<MachineView[]>(
  (signal) => {
    const listed = new Set((props.nodes ?? []).map((entry) => entry.id));
    return api.machines.list({ signal }).then((r) => {
      machinesRead = { at: Date.now(), listed };
      return unwrap(r, "machines");
    });
  },
  { immediate: false },
);

watch(
  () => props.nodeId,
  (id) => {
    if (!id) return;
    tasks.data.value = undefined;
    guard.data.value = undefined;
    if (canTasks) void tasks.refresh();
    if (canGuard) void guard.refresh();
    if (canInventory && machinesNeedRead(machines.data.value, id, machinesRead, Date.now())) void machines.refresh();
  },
  { immediate: true },
);

const status = computed(() => (node.value ? nodeStatus(node.value) : "online"));
const statusInfo = computed(() => describeNodeStatus(status.value));
const since = computed(() => (node.value ? nodeStatusSince(node.value) : undefined));
const sinceText = computed(() => (since.value ? formatAge(Date.now() - Date.parse(since.value), locale.value) : ""));
/**
 * Why the word says what it says. The server's sentence is English and, for
 * an online node, freezes the age of the last report ("the last report
 * arrived 3s ago" beside a live "last report 5 seconds ago"), so a known
 * status reads its translated explanation; a degraded node keeps the
 * server's sentence, because it names the part that broke.
 */
const reason = computed(() => {
  if (!node.value) return "";
  if (status.value === "degraded") return nodeStatusReason(node.value) || t(statusInfo.value.hintKey);
  return t(statusInfo.value.hintKey);
});
const lastSeen = computed(() => (node.value?.last_seen && !isZeroTime(node.value.last_seen) ? node.value.last_seen : undefined));

const machine = computed(() => (node.value && machines.data.value ? nodeMachine(machines.data.value, node.value.id) : undefined));
const renewal = computed<RenewalState | undefined>(() => (machine.value?.kind === "profiled" ? machine.value.renewal : undefined));
/** A passed renewal that likely explains a node gone quiet: said beside the status, with the console a row below. */
const unpaid = computed(() => !!node.value && !!renewal.value && likelyUnpaid(renewal.value, isReporting(node.value), since.value));

function renewalText(state: RenewalState): string {
  switch (state.kind) {
    case "passed":
      return `${state.date} · ${t("fleet.inventory.renewal.overdue", { days: state.days })}`;
    case "today":
      return `${state.date} · ${t("fleet.inventory.renewal.dueToday")}`;
    case "upcoming":
      return `${state.date} · ${t("fleet.inventory.renewal.daysLeft", { days: state.days })}`;
    case "incomplete":
      return t("fleet.inventory.renewal.incomplete");
    default:
      return t("fleet.inventory.renewal.notTracked");
  }
}

function renewalTone(state: RenewalState): string | undefined {
  if (state.kind === "passed") return "text-destructive";
  if (state.kind === "today" || state.kind === "incomplete" || (state.kind === "upcoming" && state.soon)) return "text-warning-text";
  return undefined;
}

const links = useMachineLinkReveal();

const queue = computed(() => (node.value && tasks.data.value ? buildNodeQueue(tasks.data.value, node.value.id) : undefined));

const POSTURE_KEY: Record<string, string> = { secured: "secured", password_open: "passwordOpen", partial: "partial", unknown: "unknown" };
const posture = computed(() => guard.data.value?.posture);
const postureText = computed(() => (posture.value ? t(`networking.sshGuard.posture.${POSTURE_KEY[posture.value.state] ?? "unknown"}`) : ""));
const postureTone = computed(() => {
  switch (posture.value?.state) {
    case "secured":
      return "text-foreground";
    case "password_open":
      return "text-destructive";
    case "partial":
      return "text-warning-text";
    default:
      return "text-muted-foreground";
  }
});

const VPN_CORE = "latticenet.vpn-core";
const hasLines = computed(() => !!plugins.findPlugin(VPN_CORE));
const linesTo = computed(() => ({ path: `/plugins/${VPN_CORE}/lines`, query: { view: "lines", q: node.value?.name ?? "" } }));

const canTerminal = computed(() => auth.can("terminal:open") && !!node.value && isReporting(node.value));
const terminalReason = computed(() => {
  if (!auth.can("terminal:open")) return t("fleet.nodes.sheet.terminalNoScope");
  if (node.value && nodeStatus(node.value) === "disabled") return t("fleet.nodes.sheet.terminalDisabled");
  if (node.value && !isReporting(node.value)) return t("fleet.nodes.sheet.terminalNotReporting");
  return "";
});

const STATUS_TONE: Record<string, string> = {
  success: "text-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
</script>

<template>
  <ObjectSheet
    :open="!!nodeId"
    :title="node?.name ?? nodeId ?? ''"
    :subtitle="node ? [node.id, node.public_ip].filter(Boolean).join(' · ') : undefined"
    :page-to="node ? { name: 'node-detail', params: { id: node.id } } : undefined"
    :state="state"
    :error="error"
    :return-focus="returnFocus"
    :gone-title="$t('fleet.nodes.sheet.goneTitle')"
    :gone-description="$t('fleet.nodes.sheet.goneDescription')"
    @close="emit('close')"
    @retry="emit('retry')"
  >
    <div v-if="node" class="space-y-5 text-sm">
      <!-- Status and why: the first thing an opened node answers. -->
      <section class="space-y-1.5" :aria-label="$t('fleet.nodes.sheet.status')">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot :status="statusInfo.health" />
          <span :class="['font-medium', STATUS_TONE[statusInfo.tone]]">{{ $t(statusInfo.labelKey) }}</span>
          <span v-if="sinceText && status !== 'online'" class="text-muted-foreground">{{ $t('fleet.nodes.sheet.for', { age: sinceText }) }}</span>
          <span v-if="lastSeen" class="ms-auto font-mono text-xs text-muted-foreground" :title="lastSeen">
            {{ $t('fleet.nodes.sheet.lastReport', { when: formatRelativeTime(lastSeen) }) }}
          </span>
        </p>
        <p v-if="reason" class="text-muted-foreground">{{ reason }}</p>
        <p v-if="unpaid && renewal?.kind === 'passed'" class="text-warning-text" data-testid="node-sheet-unpaid">
          {{ $t('fleet.nodes.sheet.likelyUnpaid', { date: renewal.date }) }}
        </p>
      </section>

      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
        <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.tasks') }}</dt>
        <dd class="min-w-0">
          <template v-if="!canTasks"><span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.noAccess') }}</span></template>
          <template v-else-if="queue">
            <p>
              <span :class="queue.stalled ? 'font-medium text-destructive' : undefined">{{ $t('fleet.nodes.sheet.stalled', { n: queue.stalled }) }}</span>
              <span class="text-muted-foreground"> · </span>{{ $t('fleet.nodes.sheet.running', { n: queue.running }) }}
              <span class="text-muted-foreground"> · </span>{{ $t('fleet.nodes.sheet.queued', { n: queue.queued }) }}
            </p>
            <ul v-if="queue.entries.length" class="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
              <li v-for="entry in queue.entries.slice(0, 4)" :key="entry.id" class="truncate">
                {{ entry.id }} · {{ entry.stalled ? $t('fleet.nodes.sheet.stalledWord') : entry.running ? $t('fleet.nodes.sheet.runningWord') : $t('fleet.nodes.sheet.queuedWord') }}
                <template v-if="entry.createdAt"> · {{ formatRelativeTime(entry.createdAt) }}</template>
              </li>
            </ul>
            <RouterLink
              :to="{ name: 'tasks', query: { node_id: node.id } }"
              class="mt-1 inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {{ $t('fleet.nodes.sheet.allTasks') }}
            </RouterLink>
          </template>
          <template v-else-if="tasks.error.value">
            <span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.notRead', { reason: proofReason(tasks.error.value) }) }}</span>
          </template>
          <span v-else class="text-muted-foreground">{{ $t('fleet.nodes.sheet.reading') }}</span>
        </dd>

        <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.ssh') }}</dt>
        <dd class="min-w-0">
          <template v-if="!canGuard"><span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.noAccess') }}</span></template>
          <template v-else-if="posture">
            <p :class="postureTone">{{ postureText }}</p>
            <p v-if="posture.reason" class="text-xs text-muted-foreground">{{ posture.reason }}</p>
            <RouterLink
              :to="{ name: 'network-ssh-guard', query: { node_id: node.id } }"
              class="mt-1 inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {{ $t('fleet.nodes.sheet.openGuard') }}
            </RouterLink>
          </template>
          <template v-else-if="guard.error.value">
            <span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.notRead', { reason: proofReason(guard.error.value) }) }}</span>
          </template>
          <span v-else-if="guard.loading.value" class="text-muted-foreground">{{ $t('fleet.nodes.sheet.reading') }}</span>
          <span v-else class="text-muted-foreground">{{ $t('fleet.nodes.sheet.notEnrolled') }}</span>
        </dd>

        <template v-if="hasLines">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.lines') }}</dt>
          <dd class="min-w-0">
            <RouterLink :to="linesTo" class="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
              {{ $t('fleet.nodes.sheet.openLines') }}
            </RouterLink>
          </dd>
        </template>

        <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.machine') }}</dt>
        <dd class="min-w-0" data-testid="node-sheet-machine">
          <template v-if="!canInventory"><span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.noAccess') }}</span></template>
          <template v-else-if="machine?.kind === 'unreadable' && !machines.refreshing.value"><span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.noAccess') }}</span></template>
          <template v-else-if="machine?.kind === 'unprofiled'">
            <p class="text-muted-foreground">{{ $t('fleet.nodes.sheet.machineUnprofiled') }}</p>
            <RouterLink
              :to="{ name: 'inventory', query: { node: node.id } }"
              class="mt-1 inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {{ $t('fleet.nodes.sheet.openInventory') }}
            </RouterLink>
          </template>
          <template v-else-if="machine?.kind === 'profiled'">
            <p class="break-words">{{ [machine.machine.vendor || $t('fleet.inventory.group.unknownVendor'), machine.machine.region].filter(Boolean).join(' · ') }}</p>
            <p class="font-mono text-xs" :class="renewalTone(machine.renewal)">{{ renewalText(machine.renewal) }}</p>
            <p v-if="machine.machine.auto_roll" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.autoRoll') }}</p>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                v-if="consoleAction(machine.machine, canRevealLinks) === 'reveal'"
                type="button"
                variant="outline"
                size="sm"
                class="pointer-coarse:min-h-11"
                :disabled="!!links.pending.value"
                @click="links.reveal(machine.machine, 'console')"
              >
                <RefreshCw v-if="links.pending.value === links.pendingKey(machine.machine, 'console')" class="size-3.5 animate-spin" aria-hidden="true" />
                <ExternalLink v-else class="size-3.5" aria-hidden="true" />
                {{ $t('fleet.nodes.sheet.providerConsole') }}
              </Button>
              <span v-else-if="consoleAction(machine.machine, canRevealLinks) === 'stored'" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.list.consoleLinkStored') }}</span>
              <RouterLink
                :to="{ name: 'inventory', query: { node: node.id } }"
                class="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {{ $t('fleet.nodes.sheet.openInventory') }}
              </RouterLink>
            </div>
          </template>
          <template v-else-if="machines.error.value">
            <span class="text-muted-foreground">{{ $t('fleet.nodes.sheet.notRead', { reason: proofReason(machines.error.value) }) }}</span>
          </template>
          <span v-else class="text-muted-foreground">{{ $t('fleet.nodes.sheet.reading') }}</span>
        </dd>

        <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.agent') }}</dt>
        <dd class="font-mono text-xs">{{ node.agent_version || $t('fleet.nodes.sheet.notReported') }}</dd>

        <template v-if="node.host_facts?.hostname || node.host_facts?.os">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.sheet.host') }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">
            {{ [node.host_facts?.hostname, node.host_facts?.os, node.host_facts?.arch].filter(Boolean).join(' · ') }}
          </dd>
        </template>

        <template v-if="node.tags?.length">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.table.colTags') }}</dt>
          <dd class="min-w-0 break-words text-xs">{{ node.tags.join(', ') }}</dd>
        </template>

        <template v-if="lastSeen">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.table.colLastSeen') }}</dt>
          <dd class="font-mono text-xs">{{ formatDateTime(lastSeen) }}</dd>
        </template>
      </dl>
    </div>

    <template #actions>
      <p v-if="terminalReason" class="me-auto text-xs text-muted-foreground">{{ terminalReason }}</p>
      <Button v-if="node" variant="outline" size="sm" type="button" :disabled="!canTerminal" @click="emit('terminal', node)">
        <SquareTerminal aria-hidden="true" />
        {{ $t('fleet.nodes.list.openTerminal') }}
      </Button>
      <RowMenu v-if="node && menuItems.length" :name="node.name || node.id" :items="menuItems" />
    </template>
  </ObjectSheet>
  <!-- After the sheet, so the step-up prompt stacks above it. -->
  <MachineLinkStepUpDialog :step-up="links.stepUp" />
</template>
