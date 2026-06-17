<script setup lang="ts">
import { ref } from "vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import AppSidebar from "./components/AppSidebar.vue";
import AppHeader from "./components/AppHeader.vue";

const collapsed = ref(false);
const mobileOpen = ref(false);
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
        <AppHeader @toggle-mobile="mobileOpen = !mobileOpen" />

        <main id="main-content" role="main" tabindex="-1" class="flex-1 overflow-y-auto">
          <RouterView v-slot="{ Component, route }">
            <Transition name="page" mode="out-in">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
        </main>
      </div>
    </div>

    <Toaster />
  </TooltipProvider>
</template>
