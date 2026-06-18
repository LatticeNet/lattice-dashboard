<script setup lang="ts">
import { ref, computed, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useUiStore } from "@/stores/ui";
import AppSidebar from "./components/AppSidebar.vue";
import AppHeader from "./components/AppHeader.vue";
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

const mobileOpen = ref(false);
const commandOpen = ref(false);

// Reflect the persisted density preference onto <html data-density> so the
// opt-in `density-*` utilities in app.css take effect. Runs on mount and on
// every change without a websocket — pure local UI state.
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
        v-model:mobile-open="mobileOpen"
      />

      <div class="flex min-w-0 flex-1 flex-col">
        <AppHeader
          @toggle-mobile="mobileOpen = !mobileOpen"
          @open-command="commandOpen = true"
        />

        <main id="main-content" role="main" tabindex="-1" class="flex-1 overflow-y-auto">
          <RouterView v-slot="{ Component, route }">
            <!-- Instant nav: enter-only fade, NO mode="out-in" (which forced a
                 ~0.22s fade-out before the next view mounted, making tab clicks
                 feel unresponsive). The new view mounts immediately. -->
            <Transition name="page-fade">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
        </main>
      </div>
    </div>

    <CommandPalette v-model:open="commandOpen" />

    <Toaster />
  </TooltipProvider>
</template>
