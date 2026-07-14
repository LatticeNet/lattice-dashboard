import { defineStore } from "pinia";
import { ref } from "vue";
import {
  SIDEBAR_DESKTOP_DEFAULT_WIDTH,
  clampSidebarDesktopWidth,
} from "../layout/sidebarModel.ts";

export type Density = "comfortable" | "compact";

const SIDEBAR_KEY = "lattice.ui.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "lattice.ui.sidebarDesktopWidth";
const DENSITY_KEY = "lattice.ui.density";

function isDensity(v: string | null): v is Density {
  return v === "comfortable" || v === "compact";
}

/**
 * Shell/UI preferences (sidebar collapse, density). Persisted to localStorage
 * under `lattice.*` keys, mirroring the manual persistence pattern in the theme
 * store so values survive reloads without depending on a global plugin.
 */
export const useUiStore = defineStore("ui", () => {
  const sidebarCollapsed = ref<boolean>(
    localStorage.getItem(SIDEBAR_KEY) === "true",
  );
  const persistedSidebarWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const sidebarDesktopWidth = ref<number>(
    clampSidebarDesktopWidth(
      persistedSidebarWidth === null
        ? SIDEBAR_DESKTOP_DEFAULT_WIDTH
        : Number(persistedSidebarWidth),
    ),
  );
  const density = ref<Density>(
    isDensity(localStorage.getItem(DENSITY_KEY))
      ? (localStorage.getItem(DENSITY_KEY) as Density)
      : "comfortable",
  );

  function setSidebarCollapsed(next: boolean) {
    sidebarCollapsed.value = next;
    localStorage.setItem(SIDEBAR_KEY, String(next));
  }

  function toggleSidebar() {
    setSidebarCollapsed(!sidebarCollapsed.value);
  }

  function setSidebarDesktopWidth(next: number) {
    const clamped = clampSidebarDesktopWidth(next);
    sidebarDesktopWidth.value = clamped;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  }

  function resetSidebarDesktopWidth() {
    setSidebarDesktopWidth(SIDEBAR_DESKTOP_DEFAULT_WIDTH);
  }

  function setDensity(next: Density) {
    density.value = next;
    localStorage.setItem(DENSITY_KEY, next);
  }

  function toggleDensity() {
    setDensity(density.value === "comfortable" ? "compact" : "comfortable");
  }

  return {
    sidebarCollapsed,
    sidebarDesktopWidth,
    density,
    setSidebarCollapsed,
    toggleSidebar,
    setSidebarDesktopWidth,
    resetSidebarDesktopWidth,
    setDensity,
    toggleDensity,
  };
});
