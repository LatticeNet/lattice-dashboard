<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  ComboboxRoot,
  ComboboxInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxItem,
  VisuallyHidden,
} from "reka-ui";
import { ArrowRight, CalendarCheck, Keyboard, ListChecks, Search, Server, Share2, ShieldCheck, UserPlus, Zap } from "lucide-vue-next";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import type { NavItem } from "@/router/nav";
import { api, isActionablePendingApproval, unwrap, type ApprovalView, type Node } from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { approvalRawLabel, approvalTitleMessage } from "@/lib/approvalKind";
import { partitionBatchResults, runWithConcurrency } from "@/views/operations/approvalsModel";
import { approvalDigest } from "@/views/operations/approvalsListModel";
import { useConsoleNavigation } from "@/layout/useConsoleNavigation";
import { shortcutsHelpOpen } from "@/layout/useKeyboardShortcuts";
import {
  createTtlCache,
  filterPendingSystemApprovals,
  paletteIdJump,
  paletteJumpLocation,
  paletteTermsKey,
  rankPaletteEntries,
  type PaletteEntry,
  type PaletteGroup,
} from "./commandPaletteModel";

/**
 * Cmd/Ctrl+K command palette.
 *
 * It reaches what an operator comes to do, not only the page titles: every
 * page the sidebar lists (the official plugins' pages in their console
 * sections and third-party ones under Extensions, from the same
 * useConsoleNavigation the sidebar reads, so it can never offer a page the
 * principal may not open), nodes by name, id, address and tag, the
 * approvals waiting, a pasted approval, task or node id, and a few actions
 * ("approve", "renew", "add VPN user", "share subscription"). Verbs and
 * synonyms find pages through the locales' search words.
 *
 * Nodes and pending approvals are read when the palette opens, each behind
 * a 30 s cache, and the last answer stays on screen while a refresh runs, so
 * opening it never waits on the network. Ranking is a pure function
 * (commandPaletteModel.rankPaletteEntries); the Combobox's own filter is
 * off. Built on reka-ui DialogRoot (focus trap, Esc) wrapping a ComboboxRoot
 * (arrows, Home, End, Enter).
 *
 * Recents keep nav names only, never anything sensitive.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

const RECENTS_KEY = "lattice.ui.commandRecents";
const RECENTS_MAX = 5;
const CACHE_MS = 30_000;
const LIMITS: Partial<Record<PaletteGroup, number>> = { action: 5, approval: 6, node: 8, page: 12 };

const search = ref("");
const query = computed(() => search.value.trim());

const isOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

type ActionId = "approve-system-events" | "keyboard-shortcuts";
type Payload =
  | { type: "nav"; item: NavItem; icon: Component }
  | { type: "go"; to: RouteLocationRaw; icon: Component }
  | { type: "action"; id: ActionId; icon: Component };
type Entry = PaletteEntry<Payload>;

// ── Pages ─────────────────────────────────────────────────────────────────

const { consoleSections, extensionItems } = useConsoleNavigation();

interface PageGroup {
  id: string;
  label: string;
  items: NavItem[];
}

const pageGroups = computed<PageGroup[]>(() => [
  ...consoleSections.value.map((section) => ({ id: section.id, label: t(`nav.sections.${section.id}`), items: section.items })),
  ...(extensionItems.value.length
    ? [{ id: "extensions", label: t("shell.sidebar.extensions"), items: extensionItems.value as NavItem[] }]
    : []),
]);

/** Every page the principal may open, by nav name (recents and actions resolve through it). */
const itemsByName = computed(() => {
  const map = new Map<string, NavItem>();
  for (const group of pageGroups.value) for (const item of group.items) map.set(item.name, item);
  return map;
});

function navLabel(item: NavItem): string {
  return item.plugin ? item.title : t(`nav.items.${item.name}`);
}

/** A locale's search words for `key`, and the English ones when they differ. */
function termsOf(key: string | null): string[] {
  if (!key) return [];
  const path = `shell.command.terms.${key}`;
  const local = t(path);
  const english = t(path, {}, { locale: "en" });
  return local === english ? [local] : [local, english];
}

function pageEntry(item: NavItem, group: PageGroup, withDetail: boolean): Entry {
  const route = (item as NavItem & { route?: string }).route;
  return {
    key: `page:${item.name}`,
    group: "page",
    label: navLabel(item),
    detail: withDetail ? (item.plugin ? `${group.label} · ${item.plugin.name}` : group.label) : undefined,
    terms: [...termsOf(paletteTermsKey({ name: item.name, plugin: item.plugin, route })), item.plugin?.name ?? "", item.path],
    payload: { type: "nav", item, icon: item.icon as Component },
  };
}

const pageEntries = computed<Entry[]>(() => pageGroups.value.flatMap((group) => group.items.map((item) => pageEntry(item, group, true))));

// ── Recents ───────────────────────────────────────────────────────────────

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

const recentNames = ref<string[]>(readRecents());

/** Recent pages still visible under the current scopes. */
const recentEntries = computed<Entry[]>(() =>
  recentNames.value
    .map((name) => pageEntries.value.find((entry) => entry.key === `page:${name}`))
    .filter((entry): entry is Entry => entry !== undefined)
    .slice(0, RECENTS_MAX)
    .map((entry) => ({ ...entry, key: `recent:${entry.key}`, detail: undefined })),
);

function pushRecent(name: string) {
  const next = [name, ...recentNames.value.filter((n) => n !== name)].slice(0, RECENTS_MAX);
  recentNames.value = next;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / disabled storage */
  }
}

// ── Nodes ─────────────────────────────────────────────────────────────────

const nodesCache = createTtlCache<Node[]>(CACHE_MS);
const nodes = ref<Node[]>([]);

async function refreshNodes(): Promise<void> {
  if (!itemsByName.value.has("nodes")) {
    nodes.value = [];
    return;
  }
  try {
    nodes.value = await nodesCache.load(() => api.nodes.list().then((r) => unwrap(r, "nodes")));
  } catch {
    // Keep the last list: a node that existed thirty seconds ago is still
    // the right place to jump to, and its page says if it is gone.
  }
}

const nodeNames = computed(() => new Map(nodes.value.map((node) => [node.id, node.name])));

const nodeEntries = computed<Entry[]>(() =>
  nodes.value.map((node) => {
    const address = node.public_ip || node.internal_ip || node.public_ipv6 || "";
    return {
      key: `node:${node.id}`,
      group: "node",
      label: node.name || node.id,
      detail: [address, ...(node.tags ?? []).slice(0, 3)].filter(Boolean).join(" · ") || node.id,
      terms: [
        node.id,
        node.public_ip ?? "",
        node.public_ipv6 ?? "",
        node.internal_ip ?? "",
        node.internal_ipv6 ?? "",
        ...(node.tags ?? []),
        node.role ?? "",
        node.geo?.city ?? "",
        node.geo?.country ?? "",
        node.geo?.provider ?? "",
      ].filter(Boolean),
      payload: { type: "go", to: { name: "node-detail", params: { id: node.id } }, icon: Server },
    };
  }),
);

// ── Approvals ─────────────────────────────────────────────────────────────
// The server proposes its own plans (fleet upgrades, metadata syncs) stamped
// with the lattice-server actor. When any are pending, the palette offers one
// batch action that runs the exact event-card path from the Approvals inbox,
// same plan-digest binding, same single-item approve endpoint, same
// concurrency cap. Every other pending approval is listed to open in its
// sheet, read only: the palette never decides a plan the operator has not
// seen. The list is fetched on open behind a 30s cache; a failed fetch keeps
// the last answer and hides the batch action until the next open.

const approvalsCache = createTtlCache<ApprovalView[]>(CACHE_MS);
const pendingApprovals = ref<ApprovalView[]>([]);
const pendingSystemApprovals = ref<ApprovalView[]>([]);
const systemActionRunning = ref(false);

async function refreshApprovals(): Promise<void> {
  if (!itemsByName.value.has("approvals")) {
    pendingApprovals.value = [];
    pendingSystemApprovals.value = [];
    return;
  }
  try {
    const approvals = await approvalsCache.load(() => api.approvals.list({ status: "pending" }).then((r) => unwrap(r, "approvals")));
    pendingApprovals.value = approvals.filter((item) => item.status === "pending");
    // Stale plans would fail server-side, so the batch counts only the items
    // the Approvals event cards would also act on.
    pendingSystemApprovals.value = filterPendingSystemApprovals(approvals).filter(isActionablePendingApproval);
  } catch {
    pendingSystemApprovals.value = [];
  }
}

const showSystemApproveAction = computed(
  () => pendingSystemApprovals.value.length > 0 && auth.can("network:apply"),
);

function approvalTitle(approval: ApprovalView): string {
  const message = approvalTitleMessage(approval);
  return t(message.key, message.params);
}

const approvalEntries = computed<Entry[]>(() =>
  pendingApprovals.value.map((approval) => ({
    key: `approval:${approval.id}`,
    group: "approval",
    label: approvalTitle(approval),
    detail: t("shell.command.approvalDetail", {
      node: nodeNames.value.get(approval.node_id) ?? approval.node_id,
      raw: approvalRawLabel(approval),
    }),
    terms: [approval.id, approval.node_id, nodeNames.value.get(approval.node_id) ?? "", ...termsOf("approvals")],
    payload: { type: "go", to: { path: "/approvals", query: { open: approval.id } }, icon: ShieldCheck },
  })),
);

// ── Actions ───────────────────────────────────────────────────────────────

const actionEntries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  if (showSystemApproveAction.value) {
    out.push({
      key: "action:approve-system-events",
      group: "action",
      label: t("shell.command.approveSystemEvents"),
      detail: String(pendingSystemApprovals.value.length),
      terms: termsOf("reviewNext"),
      payload: { type: "action", id: "approve-system-events", icon: Zap },
    });
  }
  // Next in the inbox's order: the actionable ones first, as the inbox asks.
  const next = pendingApprovals.value.find(isActionablePendingApproval) ?? pendingApprovals.value[0];
  if (next) {
    out.push({
      key: "action:review-next",
      group: "action",
      label: t("shell.command.reviewNext"),
      detail: t("shell.command.reviewNextDetail", { n: pendingApprovals.value.length }, pendingApprovals.value.length),
      terms: termsOf("reviewNext"),
      payload: { type: "go", to: { path: "/approvals", query: { open: next.id } }, icon: ListChecks },
    });
  }
  // vpn-core's page state has no "new identity" key yet, so the action lands
  // on Users, where New identity is one click; the plugin half is queued.
  const vpnUsers = itemsByName.value.get("plugin:latticenet.vpn-core:users");
  if (vpnUsers?.plugin) {
    out.push({
      key: "action:add-vpn-user",
      group: "action",
      label: t("shell.command.addVpnUser"),
      detail: t("shell.command.addVpnUserDetail"),
      terms: termsOf("addVpnUser"),
      payload: { type: "nav", item: vpnUsers, icon: UserPlus },
    });
  }
  if (itemsByName.value.has("platform-publishing") && auth.can("proxy:admin")) {
    out.push({
      key: "action:share-subscription",
      group: "action",
      label: t("shell.command.shareSubscription"),
      detail: t("shell.command.shareSubscriptionDetail"),
      terms: termsOf("shareSubscription"),
      // The share pane's own deep link: it opens the create form, consumes the key, and writes nothing.
      payload: { type: "go", to: { path: "/platform/publishing", query: { create: "1" } }, icon: Share2 },
    });
  }
  const upcoming = itemsByName.value.get("upcoming");
  if (upcoming) {
    out.push({
      key: "action:record-renewal",
      group: "action",
      label: t("shell.command.recordRenewal"),
      detail: t("shell.command.recordRenewalDetail"),
      terms: termsOf("recordRenewal"),
      payload: { type: "nav", item: upcoming, icon: CalendarCheck },
    });
  }
  out.push({
    key: "action:keyboard-shortcuts",
    group: "action",
    label: t("shell.command.keyboardShortcuts"),
    detail: "?",
    terms: termsOf("keyboardShortcuts"),
    payload: { type: "action", id: "keyboard-shortcuts", icon: Keyboard },
  });
  return out;
});

// ── A pasted id ───────────────────────────────────────────────────────────

const jumpEntry = computed<Entry | null>(() => {
  const jump = paletteIdJump(query.value);
  if (!jump) return null;
  const page = jump.kind === "approval" ? "approvals" : jump.kind === "task" ? "tasks" : "nodes";
  if (!itemsByName.value.has(page)) return null;
  const key = jump.kind === "approval" ? "jumpApproval" : jump.kind === "task" ? "jumpTask" : "jumpNode";
  return {
    key: `jump:${jump.id}`,
    group: "jump",
    label: t(`shell.command.${key}`, { id: jump.id }),
    terms: [jump.id],
    payload: { type: "go", to: paletteJumpLocation(jump), icon: ArrowRight },
  };
});

// ── Ranking ───────────────────────────────────────────────────────────────

const GROUP_LABEL: Record<PaletteGroup, string> = {
  jump: "shell.command.groupJump",
  action: "shell.command.actions",
  approval: "shell.command.groupApprovals",
  node: "shell.command.groupNodes",
  page: "shell.command.groupPages",
};

const rankedGroups = computed(() => {
  if (!query.value) return [];
  const entries = [
    ...(jumpEntry.value ? [jumpEntry.value] : []),
    ...actionEntries.value,
    ...approvalEntries.value,
    ...nodeEntries.value,
    ...pageEntries.value,
  ];
  const ranked = rankPaletteEntries(entries, query.value, LIMITS);
  // A jump always shows for an id, even when its label is in another script.
  if (jumpEntry.value && !ranked.some((entry) => entry.key === jumpEntry.value?.key)) ranked.unshift(jumpEntry.value);
  const groups: { id: PaletteGroup; label: string; entries: Entry[] }[] = [];
  for (const entry of ranked) {
    let group = groups.find((candidate) => candidate.id === entry.group);
    if (!group) {
      group = { id: entry.group, label: t(GROUP_LABEL[entry.group]), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
});

/** Browsing (no query): recent pages, the actions, then every page by section. */
const browseGroups = computed(() => [
  ...(recentEntries.value.length ? [{ id: "recent", label: t("shell.command.recent"), entries: recentEntries.value }] : []),
  ...(actionEntries.value.length ? [{ id: "actions", label: t("shell.command.actions"), entries: actionEntries.value }] : []),
  ...pageGroups.value.map((group) => ({ id: `section-${group.id}`, label: group.label, entries: group.items.map((item) => pageEntry(item, group, false)) })),
]);

const shownGroups = computed(() => (query.value ? rankedGroups.value : browseGroups.value));

/**
 * The Combobox's own filter is off, so it does not move the highlight when
 * the list changes; keep it on the best match, where Enter lands.
 */
const combo = ref<{ highlightFirstItem?: () => void } | null>(null);
watch(
  () => shownGroups.value.map((group) => group.entries.map((entry) => entry.key).join(",")).join("|"),
  async () => {
    await nextTick();
    combo.value?.highlightFirstItem?.();
  },
);

function onPick(value: unknown) {
  const entry = value as Entry | null | undefined;
  const payload = entry?.payload;
  if (!payload) return;
  if (payload.type === "action") {
    if (payload.id === "approve-system-events") void runApproveSystemEvents();
    if (payload.id === "keyboard-shortcuts") {
      isOpen.value = false;
      // After the palette has let go of focus, or its close would take it back.
      setTimeout(() => (shortcutsHelpOpen.value = true), 0);
    }
    return;
  }
  isOpen.value = false;
  if (payload.type === "nav") {
    pushRecent(payload.item.name);
    if (router.currentRoute.value.path !== payload.item.path) void router.push(payload.item.path);
    return;
  }
  void router.push(payload.to);
}

async function runApproveSystemEvents(): Promise<void> {
  if (systemActionRunning.value) return;
  // Re-read before firing: the 30s probe cache keeps ⌘K instant, but a batch
  // decision must bind fresh membership. An item dispositioned elsewhere
  // since the probe would otherwise be toasted as this batch's success.
  const fresh = await api.approvals.list({ status: "pending" }).then((r) => unwrap(r, "approvals"));
  const targets = filterPendingSystemApprovals(fresh).filter(isActionablePendingApproval);
  if (targets.length === 0) {
    approvalsCache.invalidate();
    pendingSystemApprovals.value = [];
    return;
  }
  systemActionRunning.value = true;
  isOpen.value = false;
  try {
    const results = await runWithConcurrency(targets, 4, async (item) => {
      // Same binding the Approvals event cards use: the plan text when the
      // row carries it, else the server's hash of it. The pending listing is
      // read without plan text now, so it is the hash.
      await api.approvals.approve(
        item.id,
        true,
        await approvalDigest(item, { hashPlan: (row) => sha256Hex(row.plan || ""), fetchFull: api.approvals.get }),
      );
    });
    const { succeeded, failed } = partitionBatchResults(targets, results);
    approvalsCache.invalidate();
    // After a partial failure the action stays offered with exactly the
    // remainder, mirroring the event-card shrink-to-failures behavior.
    pendingSystemApprovals.value = failed.map((entry) => entry.item);
    if (failed.length === 0) {
      toast.success(t("shell.command.approveSystemEventsDone", { count: succeeded.length }));
    } else {
      // Shell-scoped copy: the operations event-card text refers to "the
      // card", which does not exist in palette context. Here the honest
      // remainder is that the failures stay pending (and the action keeps
      // offering exactly them).
      toast.warning(
        t("shell.command.approveSystemEventsPartial", { done: succeeded.length, failed: failed.length }),
      );
    }
  } finally {
    systemActionRunning.value = false;
  }
}

// Reset the query and refresh recents each time the palette opens; the input
// auto-focuses on mount (reka-ui `autoFocus`). Nodes and approvals ride the
// same open event, behind their caches.
watch(isOpen, (open) => {
  if (open) {
    search.value = "";
    recentNames.value = readRecents();
    void refreshApprovals();
    void refreshNodes();
  }
});

const rowClass = cn(
  "flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-none pointer-coarse:min-h-11",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
);
</script>

<template>
  <DialogRoot v-model:open="isOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        class="fixed left-[50%] top-[15%] z-50 w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
      >
        <VisuallyHidden>
          <DialogTitle>{{ t('shell.command.title') }}</DialogTitle>
          <DialogDescription>{{ t('shell.command.description') }}</DialogDescription>
        </VisuallyHidden>

        <ComboboxRoot ref="combo" :open="true" ignore-filter class="flex flex-col" @update:model-value="onPick">
          <div class="flex items-center gap-2 border-b px-3">
            <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <ComboboxInput
              v-model="search"
              auto-focus
              :placeholder="t('shell.command.placeholder')"
              :display-value="() => ''"
              class="h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ComboboxContent
            position="inline"
            class="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-1"
            @escape-key-down="isOpen = false"
          >
            <ComboboxEmpty class="py-6 text-center text-sm text-muted-foreground">
              {{ t('shell.command.empty') }}
            </ComboboxEmpty>

            <ComboboxGroup v-for="group in shownGroups" :key="group.id" class="px-1 py-1" :data-palette-group="group.id">
              <ComboboxLabel
                class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {{ group.label }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="entry in group.entries"
                :key="entry.key"
                :value="entry"
                :text-value="entry.label"
                :class="rowClass"
                :data-palette-key="entry.key"
              >
                <component :is="entry.payload.icon" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ entry.label }}</span>
                  <span
                    v-if="entry.detail && entry.payload.type !== 'action'"
                    class="block truncate text-xs text-muted-foreground"
                  >{{ entry.detail }}</span>
                </span>
                <span
                  v-if="entry.detail && entry.payload.type === 'action'"
                  class="ml-auto shrink-0 truncate text-xs text-muted-foreground"
                >{{ entry.detail }}</span>
              </ComboboxItem>
            </ComboboxGroup>
          </ComboboxContent>
        </ComboboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
