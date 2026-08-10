<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
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
import { Search, Zap } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { NAV, type NavItem } from "@/router/nav";
import { api, isActionablePendingApproval, unwrap, type ApprovalView } from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { groupApprovalsIntoEvents, partitionBatchResults, runWithConcurrency } from "@/views/operations/approvalsModel";
import { createTtlCache, filterPendingSystemApprovals } from "./commandPaletteModel";

/**
 * Cmd/Ctrl+K command palette. Sources its items from the SAME scope-filtered NAV
 * the sidebar uses (`auth.canAny`), so it can never surface a destination the
 * operator lacks. Built on reka-ui DialogRoot (focus trap + Esc to close) wrapping
 * a ComboboxRoot which provides the search filtering and keyboard navigation
 * (arrows / Home / End / Enter) out of the box — CSP-safe, no inline scripts.
 *
 * Recents are persisted to localStorage so the most-used destinations float to
 * the top on next open. Only nav `name`s are stored, never anything sensitive.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

const RECENTS_KEY = "lattice.ui.commandRecents";
const RECENTS_MAX = 5;

const search = ref("");

const isOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

/** Scope-visible sections, mirroring AppSidebar's visibleSections logic. */
const visibleSections = computed(() =>
  NAV.map((section) => ({
    id: section.id,
    items: section.items.filter((item) => auth.canAny(item.scopes ?? [])),
  })).filter((section) => section.items.length > 0),
);

/** Flat lookup of every visible item by name (for resolving recents). */
const itemsByName = computed(() => {
  const map = new Map<string, NavItem>();
  for (const section of visibleSections.value) {
    for (const item of section.items) map.set(item.name, item);
  }
  return map;
});

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

/** Resolved recent items, kept to those still visible under current scopes. */
const recentItems = computed(() =>
  recentNames.value
    .map((name) => itemsByName.value.get(name))
    .filter((item): item is NavItem => item !== undefined)
    .slice(0, RECENTS_MAX),
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

function navItemLabel(item: NavItem): string {
  return t("nav.items." + item.name);
}

function sectionLabel(id: string): string {
  return t("nav.sections." + id);
}

function onSelect(item: NavItem) {
  pushRecent(item.name);
  isOpen.value = false;
  if (router.currentRoute.value.path !== item.path) router.push(item.path);
}

// ── Actions: approve all system events ───────────────────────────────────────
// The server proposes its own plans (fleet upgrades, metadata syncs) stamped
// with the lattice-server actor. When any are pending, the palette offers one
// batch action that runs the exact event-card path from the Approvals inbox —
// same plan-digest binding, same single-item approve endpoint, same
// concurrency cap. The list is fetched on open behind a 30s cache so rapid
// ⌘K use never hammers the API; a failed fetch just hides the action until
// the next open.
const systemApprovalsCache = createTtlCache<ApprovalView[]>(30_000);
const pendingSystemApprovals = ref<ApprovalView[]>([]);
const systemActionRunning = ref(false);

async function refreshSystemApprovals(): Promise<void> {
  try {
    const approvals = await systemApprovalsCache.load(() => api.approvals.list().then((r) => unwrap(r, "approvals")));
    // Stale plans would fail server-side, so the action counts only the items
    // the Approvals event cards would also act on.
    pendingSystemApprovals.value = filterPendingSystemApprovals(approvals).filter(isActionablePendingApproval);
  } catch {
    pendingSystemApprovals.value = [];
  }
}

const showSystemApproveAction = computed(
  () => pendingSystemApprovals.value.length > 0 && auth.can("network:apply"),
);

interface PaletteAction {
  kind: "action";
  id: "approve-system-events";
}
const approveSystemEventsAction: PaletteAction = { kind: "action", id: "approve-system-events" };

function isPaletteAction(value: unknown): value is PaletteAction {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "action";
}

async function runApproveSystemEvents(): Promise<void> {
  if (systemActionRunning.value) return;
  const groups = groupApprovalsIntoEvents(pendingSystemApprovals.value);
  const targets: ApprovalView[] = [];
  for (const group of groups) targets.push(...group.items);
  if (targets.length === 0) return;
  systemActionRunning.value = true;
  isOpen.value = false;
  try {
    const results = await runWithConcurrency(targets, 4, async (item) => {
      // Same bytes the Approvals plan review binds: sha256 of the plan string.
      await api.approvals.approve(item.id, true, await sha256Hex(item.plan || ""));
    });
    const { succeeded, failed } = partitionBatchResults(targets, results);
    systemApprovalsCache.invalidate();
    // After a partial failure the action stays offered with exactly the
    // remainder, mirroring the event-card shrink-to-failures behavior.
    pendingSystemApprovals.value = failed.map((entry) => entry.item);
    if (failed.length === 0) {
      toast.success(t("operations.approvals.events.toastBatchApproveDone", { count: succeeded.length }));
    } else {
      toast.warning(
        t("operations.approvals.events.toastBatchApprovePartial", { done: succeeded.length, failed: failed.length }),
      );
    }
  } finally {
    systemActionRunning.value = false;
  }
}

// Reset the query and refresh recents each time the palette opens; the input
// auto-focuses on mount (reka-ui `autoFocus`). The system-approvals check rides
// the same open event, behind its 30s cache.
watch(isOpen, (open) => {
  if (open) {
    search.value = "";
    recentNames.value = readRecents();
    void refreshSystemApprovals();
  }
});
</script>

<template>
  <DialogRoot v-model:open="isOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        class="fixed left-[50%] top-[15%] z-50 w-full max-w-lg translate-x-[-50%] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
      >
        <VisuallyHidden>
          <DialogTitle>{{ t('shell.command.title') }}</DialogTitle>
          <DialogDescription>{{ t('shell.command.description') }}</DialogDescription>
        </VisuallyHidden>

        <ComboboxRoot
          :open="true"
          class="flex flex-col"
          @update:model-value="
            (value) => {
              if (!value) return;
              if (isPaletteAction(value)) void runApproveSystemEvents();
              else onSelect(value as NavItem);
            }
          "
        >
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
            class="max-h-80 overflow-y-auto overscroll-contain p-1"
            @escape-key-down="isOpen = false"
          >
            <ComboboxEmpty class="py-6 text-center text-sm text-muted-foreground">
              {{ t('shell.command.empty') }}
            </ComboboxEmpty>

            <!-- Actions: live dispositions, gated on server state + scope -->
            <ComboboxGroup v-if="showSystemApproveAction" class="px-1 py-1">
              <ComboboxLabel
                class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {{ t('shell.command.actions') }}
              </ComboboxLabel>
              <ComboboxItem
                :value="approveSystemEventsAction"
                :class="
                  cn(
                    'flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-none',
                    'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                  )
                "
              >
                <Zap class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="truncate">{{ t('shell.command.approveSystemEvents') }}</span>
                <span
                  class="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground"
                >
                  {{ pendingSystemApprovals.length }}
                </span>
              </ComboboxItem>
            </ComboboxGroup>

            <!-- Recents (only when not actively searching) -->
            <ComboboxGroup v-if="!search && recentItems.length" class="px-1 py-1">
              <ComboboxLabel
                class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {{ t('shell.command.recent') }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="item in recentItems"
                :key="'recent-' + item.name"
                :value="item"
                :class="
                  cn(
                    'flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-none',
                    'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                  )
                "
              >
                <component :is="item.icon" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="truncate">{{ navItemLabel(item) }}</span>
              </ComboboxItem>
            </ComboboxGroup>

            <!-- All sections, scope-filtered like the sidebar -->
            <ComboboxGroup
              v-for="section in visibleSections"
              :key="section.id"
              class="px-1 py-1"
            >
              <ComboboxLabel
                class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {{ sectionLabel(section.id) }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="item in section.items"
                :key="item.name"
                :value="item"
                :class="
                  cn(
                    'flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-none',
                    'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                  )
                "
              >
                <component :is="item.icon" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="truncate">{{ navItemLabel(item) }}</span>
              </ComboboxItem>
            </ComboboxGroup>
          </ComboboxContent>
        </ComboboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
