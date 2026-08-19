import { defineStore } from "pinia";
import { ref } from "vue";

const PINNED_KEY = "lattice.ui.nav.pinned";
const COLLAPSED_KEY = "lattice.ui.nav.sectionsCollapsed";
const LEGACY_RECENTS_KEY = "lattice.ui.nav.recents";
const LEGACY_COLLAPSED_SECTIONS_KEY = "lattice.ui.nav.collapsedSections";

function readStringList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeStringList(key: string, value: readonly string[]) {
  try {
    localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* Ignore quota/disabled storage; the in-memory state still works this session. */
  }
}

function removeLegacySidebarState() {
  try {
    // These keys powered the retired all-open/auto-recent sidebar. Removing them
    // prevents stale browser state from influencing the current navigation model.
    localStorage.removeItem(LEGACY_RECENTS_KEY);
    localStorage.removeItem(LEGACY_COLLAPSED_SECTIONS_KEY);
  } catch {
    /* Storage can be disabled; navigation remains functional without persistence. */
  }
}

/** Explicit operator pins only; route visits are never promoted automatically. */
export const useNavShortcutsStore = defineStore("navShortcuts", () => {
  removeLegacySidebarState();
  const pinned = ref<string[]>(readStringList(PINNED_KEY));

  /**
   * Sections the operator deliberately shut. Everything absent from this set is
   * open, so a fresh console shows the whole IA and only a real preference is
   * persisted.
   */
  const collapsedSections = ref<Set<string>>(new Set(readStringList(COLLAPSED_KEY)));

  function isPinned(id: string): boolean {
    return pinned.value.includes(id);
  }

  function pin(id: string) {
    if (!id || isPinned(id)) return;
    pinned.value = [...pinned.value, id];
    writeStringList(PINNED_KEY, pinned.value);
  }

  function unpin(id: string) {
    if (!isPinned(id)) return;
    pinned.value = pinned.value.filter((candidate) => candidate !== id);
    writeStringList(PINNED_KEY, pinned.value);
  }

  function togglePin(id: string) {
    isPinned(id) ? unpin(id) : pin(id);
  }

  function isSectionCollapsed(id: string): boolean {
    return collapsedSections.value.has(id);
  }

  function setCollapsedSections(next: Set<string>) {
    // Reconciliation runs on every navigation and usually finds nothing to
    // change. localStorage writes are synchronous, so a no-op stays a no-op.
    const current = collapsedSections.value;
    if (current.size === next.size && [...next].every((id) => current.has(id))) return;
    collapsedSections.value = next;
    writeStringList(COLLAPSED_KEY, [...next]);
  }

  return {
    pinned,
    isPinned,
    pin,
    unpin,
    togglePin,
    collapsedSections,
    isSectionCollapsed,
    setCollapsedSections,
  };
});
