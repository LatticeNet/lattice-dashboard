import { defineStore } from "pinia";
import { ref } from "vue";
import {
  SIDEBAR_DESKTOP_DEFAULT_WIDTH,
  clampSidebarDesktopWidth,
} from "../layout/sidebarModel.ts";

export type Density = "comfortable" | "compact";

const SIDEBAR_KEY = "lattice.ui.sidebarCollapsed";
const SIDEBAR_MEDIUM_KEY = "lattice.ui.sidebarCollapsedMedium";
const SIDEBAR_WIDTH_KEY = "lattice.ui.sidebarDesktopWidth";
const DENSITY_KEY = "lattice.ui.density";

function isDensity(v: string | null): v is Density {
  return v === "comfortable" || v === "compact";
}

/**
 * Shell/UI preferences (sidebar collapse per width band, density). Persisted to localStorage
 * under `lattice.*` keys, mirroring the manual persistence pattern in the theme
 * store so values survive reloads without depending on a global plugin.
 */
export const useUiStore = defineStore("ui", () => {
  const sidebarCollapsed = ref<boolean>(
    localStorage.getItem(SIDEBAR_KEY) === "true",
  );
  // From 768 to 1023 px a 240 px sidebar leaves a table about 480 px, so
  // that band starts on the 64 px rail and remembers its own toggle; the
  // wide band keeps the preference it always had.
  const sidebarCollapsedMedium = ref<boolean>(
    localStorage.getItem(SIDEBAR_MEDIUM_KEY) !== "false",
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

  function setSidebarCollapsedMedium(next: boolean) {
    sidebarCollapsedMedium.value = next;
    localStorage.setItem(SIDEBAR_MEDIUM_KEY, String(next));
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
    sidebarCollapsedMedium,
    sidebarDesktopWidth,
    density,
    setSidebarCollapsed,
    toggleSidebar,
    setSidebarCollapsedMedium,
    setSidebarDesktopWidth,
    resetSidebarDesktopWidth,
    setDensity,
    toggleDensity,
  };
});
