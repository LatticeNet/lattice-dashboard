import { defineStore } from "pinia";
import { ref } from "vue";

const PINNED_KEY = "lattice.ui.nav.pinned";
const LEGACY_RECENTS_KEY = "lattice.ui.nav.recents";
const LEGACY_COLLAPSED_SECTIONS_KEY = "lattice.ui.nav.collapsedSections";

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function removeLegacySidebarState() {
  try {
    // These keys powered the retired all-open/auto-recent sidebar. Removing them
    // prevents stale browser state from influencing the new workspace model.
    localStorage.removeItem(LEGACY_RECENTS_KEY);
    localStorage.removeItem(LEGACY_COLLAPSED_SECTIONS_KEY);
  } catch {
    /* Storage can be disabled; navigation remains functional without persistence. */
  }
}

/** Explicit operator pins only; route visits are never promoted automatically. */
export const useNavShortcutsStore = defineStore("navShortcuts", () => {
  removeLegacySidebarState();
  const pinned = ref<string[]>(readPinned());

  function persist() {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(pinned.value));
    } catch {
      /* Ignore quota/disabled storage; the in-memory pin still works this session. */
    }
  }

  function isPinned(id: string): boolean {
    return pinned.value.includes(id);
  }

  function pin(id: string) {
    if (!id || isPinned(id)) return;
    pinned.value = [...pinned.value, id];
    persist();
  }

  function unpin(id: string) {
    if (!isPinned(id)) return;
    pinned.value = pinned.value.filter((candidate) => candidate !== id);
    persist();
  }

  function togglePin(id: string) {
    isPinned(id) ? unpin(id) : pin(id);
  }

  return { pinned, isPinned, pin, unpin, togglePin };
});
