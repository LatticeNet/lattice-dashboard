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
    <div class="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar
        v-model:collapsed="collapsed"
        v-model:mobile-open="mobileOpen"
      />

      <div class="flex min-w-0 flex-1 flex-col">
        <AppHeader @toggle-mobile="mobileOpen = !mobileOpen" />

        <main class="flex-1 overflow-y-auto">
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
