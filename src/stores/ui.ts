import { defineStore } from "pinia";
import { ref } from "vue";

export type Density = "comfortable" | "compact";

const SIDEBAR_KEY = "lattice.ui.sidebarCollapsed";
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

  function setDensity(next: Density) {
    density.value = next;
    localStorage.setItem(DENSITY_KEY, next);
  }

  function toggleDensity() {
    setDensity(density.value === "comfortable" ? "compact" : "comfortable");
  }

  return {
    sidebarCollapsed,
    density,
    setSidebarCollapsed,
    toggleSidebar,
    setDensity,
    toggleDensity,
  };
});
