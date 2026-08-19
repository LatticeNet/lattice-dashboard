<script setup lang="ts">
/**
 * One section of the collapsed rail, with its destinations in a flyout.
 *
 * The rail used to render every destination in the console as a flat column of
 * twenty-five identical icons. Collapsing the sidebar therefore destroyed the
 * only thing the sidebar was for: an operator could see that there were many
 * places to go and nothing about which of them was Fleet and which was
 * Networking. Keeping the section as the unit of the rail keeps the IA legible
 * at 64px, and the flyout is where the destinations live.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/router/nav";
import { formatBadge, type NavSignal } from "../navSignals";
import { nextNavIndex } from "../navigationModel";
import SidebarItem from "./SidebarItem.vue";

const props = defineProps<{
  /** Stable id, used for the flyout's element id. */
  id: string;
  label: string;
  icon: unknown;
  items: NavItem[];
  /** Aggregate of everything happening inside this section. */
  signal?: NavSignal;
  /** Per-destination signals, keyed by nav item name. */
  signals?: Readonly<Record<string, NavSignal>>;
  /** True when the current route lives in this section. */
  active: boolean;
  /** Manifest-titled items (plugins) skip the static i18n lookup. */
  plugin?: boolean;
}>();

const emit = defineEmits<{ (e: "navigate"): void }>();

const { t } = useI18n();
const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const position = ref<{ top: number; left: number }>({ top: 0, left: 0 });
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const panelId = computed(() => `rail-flyout-${props.id}`);

/** The rail is icon-only, so the count has to be said rather than shown. */
const triggerLabel = computed(() =>
  props.signal ? `${props.label}, ${props.signal.label}` : props.label,
);

function measure() {
  const el = trigger.value;
  if (!el || typeof window === "undefined") return;
  const rect = el.getBoundingClientRect();
  // Clamp so a long section near the bottom of the viewport still fits.
  const estimated = 44 + props.items.length * 36;
  const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - estimated - 8));
  position.value = { top, left: rect.right + 8 };
}

function cancelClose() {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

function show() {
  cancelClose();
  measure();
  open.value = true;
}

/**
 * A small grace period so the diagonal travel from the rail icon to the panel
 * does not drop the menu out from under the pointer.
 */
function scheduleClose() {
  cancelClose();
  closeTimer = setTimeout(() => {
    open.value = false;
  }, 120);
}

function close(focusTrigger = false) {
  cancelClose();
  open.value = false;
  if (focusTrigger) trigger.value?.focus();
}

function focusItem(index: number) {
  const rows = panel.value?.querySelectorAll<HTMLElement>("[data-nav-row]");
  rows?.[index]?.focus();
}

function currentIndex(): number {
  const rows = [...(panel.value?.querySelectorAll<HTMLElement>("[data-nav-row]") ?? [])];
  return rows.findIndex((row) => row === document.activeElement);
}

async function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    close();
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    show();
    await nextTick();
    focusItem(0);
  }
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close(true);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    close(true);
    return;
  }
  const rows = panel.value?.querySelectorAll<HTMLElement>("[data-nav-row]");
  const next = nextNavIndex(rows?.length ?? 0, currentIndex(), event.key);
  if (next < 0) return;
  event.preventDefault();
  focusItem(next);
}

/** Focus leaving both the trigger and the panel closes the flyout. */
function onFocusOut(event: FocusEvent) {
  const to = event.relatedTarget as Node | null;
  if (!to) return;
  if (trigger.value?.contains(to) || panel.value?.contains(to)) return;
  close();
}

function onNavigate() {
  close();
  emit("navigate");
}

// A scroll under an absolutely measured panel leaves it pointing at nothing.
function onViewportChange() {
  if (open.value) close();
}

watch(open, (value) => {
  if (typeof window === "undefined") return;
  if (value) {
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
  } else {
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
  }
});

onBeforeUnmount(() => {
  cancelClose();
  if (typeof window === "undefined") return;
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
});
</script>

<template>
  <div
    class="relative"
    @mouseenter="show"
    @mouseleave="scheduleClose"
    @focusout="onFocusOut"
  >
    <button
      ref="trigger"
      type="button"
      :class="
        cn(
          'relative flex h-9 w-full items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        )
      "
      :data-active="active ? 'true' : 'false'"
      :aria-label="triggerLabel"
      :aria-expanded="open"
      :aria-controls="panelId"
      aria-haspopup="menu"
      @click="open ? close() : show()"
      @keydown="onTriggerKeydown"
    >
      <span class="relative">
        <component :is="icon" class="size-4 shrink-0" aria-hidden="true" />
        <span
          v-if="signal"
          :class="
            cn(
              'absolute -right-1 -top-1 size-2 rounded-full ring-2 ring-sidebar',
              signal.tone === 'attention' ? 'bg-destructive' : 'bg-warning',
            )
          "
          aria-hidden="true"
        />
      </span>
    </button>

    <div
      v-if="open"
      :id="panelId"
      ref="panel"
      role="menu"
      :aria-label="label"
      class="fixed z-50 w-56 rounded-md border border-sidebar-border bg-sidebar p-1.5 shadow-lg"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      @keydown="onPanelKeydown"
      @mouseenter="cancelClose"
      @mouseleave="scheduleClose"
    >
      <div class="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
        <span class="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {{ label }}
        </span>
        <span
          v-if="signal"
          :class="
            cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
              signal.tone === 'attention'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-warning/15 text-warning',
            )
          "
          :title="signal.label"
        >
          {{ formatBadge(signal.count) }}
        </span>
      </div>
      <SidebarItem
        v-for="item in items"
        :key="item.name"
        :item="item"
        :collapsed="false"
        :plugin="plugin"
        :signal="signals?.[item.name]"
        @click="onNavigate"
      />
      <p v-if="items.length === 0" class="px-2 py-2 text-xs text-muted-foreground">
        {{ t('common.state.noData') }}
      </p>
    </div>
  </div>
</template>
