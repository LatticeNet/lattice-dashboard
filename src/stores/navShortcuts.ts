import { defineStore } from "pinia";
import { ref } from "vue";

const PINNED_KEY = "lattice.ui.nav.pinned";
const RECENTS_KEY = "lattice.ui.nav.recents";
const COLLAPSED_SECTIONS_KEY = "lattice.ui.nav.collapsedSections";

const RECENTS_LIMIT = 5;

/**
 * A navigable target identity that survives reloads. For static NAV items this is
 * the route name (e.g. "nodes"); for plugin-contributed items it is the synthetic
 * `plugin:<id>:<route>` name the sidebar already assigns. We persist the STABLE id
 * only — icon/title/path are re-resolved against the live NAV + plugin registry on
 * render, so a removed plugin or renamed route simply drops out of the list.
 */
function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function readRecord(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Sidebar personalization: pinned shortcuts, auto-tracked recents, and per-section
 * collapse state — the Cloudflare-style "make a dense nav yours" affordances.
 * Persisted to localStorage under `lattice.ui.nav.*`, mirroring the manual
 * persistence in the ui/theme stores (no plugin dependency). All state is keyed by
 * the stable nav id above; resolution to a renderable item happens in the sidebar.
 */
export const useNavShortcutsStore = defineStore("navShortcuts", () => {
  const pinned = ref<string[]>(readList(PINNED_KEY));
  const recents = ref<string[]>(readList(RECENTS_KEY));
  const collapsedSections = ref<Record<string, boolean>>(readRecord(COLLAPSED_SECTIONS_KEY));

  function persistPinned() {
    localStorage.setItem(PINNED_KEY, JSON.stringify(pinned.value));
  }
  function persistRecents() {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.value));
  }
  function persistCollapsed() {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(collapsedSections.value));
  }

  function isPinned(id: string): boolean {
    return pinned.value.includes(id);
  }

  function pin(id: string) {
    if (!id || isPinned(id)) return;
    pinned.value = [...pinned.value, id];
    // A pinned item leaves the recents list — it now has a permanent home.
    recents.value = recents.value.filter((r) => r !== id);
    persistPinned();
    persistRecents();
  }

  function unpin(id: string) {
    if (!isPinned(id)) return;
    pinned.value = pinned.value.filter((p) => p !== id);
    persistPinned();
  }

  function togglePin(id: string) {
    isPinned(id) ? unpin(id) : pin(id);
  }

  /** Record a visit as the most-recent entry, unless it is pinned. */
  function recordVisit(id: string) {
    if (!id || isPinned(id)) return;
    const next = [id, ...recents.value.filter((r) => r !== id)].slice(0, RECENTS_LIMIT);
    recents.value = next;
    persistRecents();
  }

  function isSectionCollapsed(sectionId: string): boolean {
    return collapsedSections.value[sectionId] === true;
  }

  function toggleSection(sectionId: string) {
    collapsedSections.value = {
      ...collapsedSections.value,
      [sectionId]: !isSectionCollapsed(sectionId),
    };
    persistCollapsed();
  }

  function setSectionCollapsed(sectionId: string, value: boolean) {
    if (isSectionCollapsed(sectionId) === value) return;
    collapsedSections.value = { ...collapsedSections.value, [sectionId]: value };
    persistCollapsed();
  }

  return {
    pinned,
    recents,
    collapsedSections,
    isPinned,
    pin,
    unpin,
    togglePin,
    recordVisit,
    isSectionCollapsed,
    toggleSection,
    setSectionCollapsed,
  };
});
