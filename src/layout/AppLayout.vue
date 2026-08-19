<script setup lang="ts">
import { ref, computed, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useUiStore } from "@/stores/ui";
import AppSidebar from "./components/AppSidebar.vue";
import AppHeader from "./components/AppHeader.vue";
import TrustBanner from "./components/TrustBanner.vue";
import CommandPalette from "@/components/common/CommandPalette.vue";

const ui = useUiStore();
const { density } = storeToRefs(ui);

// Sidebar collapse persists via the ui store (localStorage-backed) so the rail
// state survives reloads. The store is the single source of truth; we expose a
// computed proxy so AppSidebar's `v-model:collapsed` keeps working unchanged.
const collapsed = computed({
  get: () => ui.sidebarCollapsed,
  set: (v: boolean) => ui.setSidebarCollapsed(v),
});

const desktopWidth = computed({
  get: () => ui.sidebarDesktopWidth,
  set: (v: number) => ui.setSidebarDesktopWidth(v),
});

const mobileOpen = ref(false);
const commandOpen = ref(false);

// Reflect the persisted density preference onto <html data-density> so the
// opt-in `density-*` utilities in app.css take effect. Runs on mount and on
// every change without a websocket. Pure local UI state.
watchEffect(() => {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-density", density.value);
  }
});
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {{ $t('shell.header.skipToContent') }}
    </a>
    <div class="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar
        v-model:collapsed="collapsed"
        v-model:desktop-width="desktopWidth"
        v-model:mobile-open="mobileOpen"
        @open-command="commandOpen = true"
      />

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <TrustBanner />

        <AppHeader
          :mobile-open="mobileOpen"
          @toggle-mobile="mobileOpen = !mobileOpen"
          @open-command="commandOpen = true"
        />

        <main
          id="main-content"
          role="main"
          tabindex="-1"
          class="min-h-0 flex-1 overflow-y-auto"
        >
          <!-- One width ceiling for every route, rather than thirty views each
               remembering to set their own. -->
          <div class="page-shell">
            <RouterView v-slot="{ Component, route }">
              <component :is="Component" :key="route.path" class="view-enter" />
            </RouterView>
          </div>
        </main>
      </div>
    </div>

    <CommandPalette v-model:open="commandOpen" />

    <Toaster />
  </TooltipProvider>
</template>
