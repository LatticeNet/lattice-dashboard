<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
} from "reka-ui";
import { Menu, Palette, LogOut, User } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuthStore } from "@/stores/auth";
import ThemeToggle from "./ThemeToggle.vue";
import AppearanceMenu from "./AppearanceMenu.vue";

defineEmits<{ (e: "toggle-mobile"): void }>();

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

const title = computed(() =>
  route.name ? t("nav.items." + String(route.name)) : t("nav.items.overview"),
);
const actorId = computed(() => auth.principal?.actor_id ?? t("shell.header.account"));

async function logout() {
  await auth.logout();
  router.push("/login");
}
</script>

<template>
  <header
    class="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur"
  >
    <!-- Mobile hamburger -->
    <Button
      variant="ghost"
      size="icon"
      class="md:hidden"
      :aria-label="$t('shell.sidebar.toggle')"
      @click="$emit('toggle-mobile')"
    >
      <Menu class="size-4" />
    </Button>

    <span class="text-sm font-medium">{{ title }}</span>

    <div class="ml-auto flex items-center gap-1">
      <ThemeToggle />

      <!-- Appearance -->
      <PopoverRoot>
        <PopoverTrigger as-child>
          <Button variant="ghost" size="icon" :aria-label="$t('shell.header.appearance')">
            <Palette class="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="8"
            align="end"
            class="z-50 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          >
            <AppearanceMenu />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      <!-- User menu -->
      <PopoverRoot>
        <PopoverTrigger as-child>
          <Button variant="ghost" size="icon" :aria-label="$t('shell.header.account')">
            <User class="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="8"
            align="end"
            class="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          >
            <div class="px-2 py-1.5">
              <p class="text-xs text-muted-foreground">{{ $t('shell.header.signedInAs') }}</p>
              <p class="truncate font-mono text-sm font-medium">{{ actorId }}</p>
            </div>
            <Separator class="my-1" />
            <Button
              variant="ghost"
              class="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="logout"
            >
              <LogOut class="size-4" aria-hidden="true" />
              {{ $t('shell.header.logout') }}
            </Button>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>
  </header>
</template>
