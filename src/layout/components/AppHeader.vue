<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useMagicKeys, useActiveElement } from "@vueuse/core";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
} from "reka-ui";
import { Menu, Palette, LogOut, User, KeyRound, Search } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuthStore } from "@/stores/auth";
import { NAV } from "@/router/nav";
import {
  NAV_SECTION_TO_NAV_ID,
  usePluginContributions,
} from "@/composables/usePluginContributions";
import ThemeToggle from "./ThemeToggle.vue";
import AppearanceMenu from "./AppearanceMenu.vue";

const emit = defineEmits<{
  (e: "toggle-mobile"): void;
  (e: "open-command"): void;
}>();

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

// Plugin-contributed views (design-10) have a dynamic title/section that no
// static `nav.items.*` / NAV section owns — resolve them from the live
// contribution instead, so the breadcrumb matches the page heading.
const { findPlugin, findView, navContributions } = usePluginContributions();
const pluginCtx = computed(() => {
  if (route.name !== "plugin-view") return null;
  return {
    pluginId: String(route.params.pluginId ?? ""),
    viewRoute: String(route.params.route ?? ""),
  };
});

const title = computed(() => {
  const ctx = pluginCtx.value;
  if (ctx) {
    return (
      findView(ctx.pluginId, ctx.viewRoute)?.title ||
      findPlugin(ctx.pluginId)?.name ||
      ctx.viewRoute
    );
  }
  return route.name ? t("nav.items." + String(route.name)) : t("nav.items.overview");
});

/**
 * Breadcrumb section, resolved from the NAV IA by matching the current route's
 * name back to its owning section id. Using the id (not route.meta.section,
 * which holds the raw English title) lets us render the localized
 * `nav.sections.*` label. Falls back to "" when no section owns the route.
 */
const sectionLabel = computed(() => {
  const ctx = pluginCtx.value;
  if (ctx) {
    // The contribution's nav entry carries the target section ("proxy"/"plugins").
    const entry = navContributions.value.find(
      (n) => n.pluginId === ctx.pluginId && n.route === ctx.viewRoute,
    );
    const navId = entry ? NAV_SECTION_TO_NAV_ID[entry.section] : undefined;
    return navId ? t("nav.sections." + navId) : "";
  }
  const name = route.name ? String(route.name) : "";
  const section = NAV.find((s) => s.items.some((item) => item.name === name));
  return section && section.id !== "overview" ? t("nav.sections." + section.id) : "";
});

const accountLabel = computed(
  () => auth.principal?.username || auth.principal?.actor_id || t("shell.header.account"),
);

// Cmd/Ctrl+K opens the command palette. `passive: false` lets us swallow the
// browser default; we ignore the shortcut while the user is typing in a field.
const activeElement = useActiveElement();
const keys = useMagicKeys({
  passive: false,
  onEventFired(e) {
    if (e.key === "k" && (e.metaKey || e.ctrlKey) && e.type === "keydown") {
      e.preventDefault();
    }
  },
});
const cmdK = keys["Cmd+K"];
const ctrlK = keys["Ctrl+K"];

function isEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

watch([cmdK, ctrlK], ([a, b]) => {
  if ((a || b) && !isEditable(activeElement.value)) emit("open-command");
});

async function logout() {
  await auth.logout();
  router.push("/login");
}

function openSecurity() {
  router.push({ name: "settings-security" });
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

    <!-- Breadcrumb: Section / Page -->
    <nav :aria-label="$t('shell.header.breadcrumb')" class="flex min-w-0 items-center text-sm">
      <span v-if="sectionLabel" class="hidden truncate text-muted-foreground sm:inline">
        {{ sectionLabel }}
        <span class="px-1.5 text-muted-foreground/50" aria-hidden="true">/</span>
      </span>
      <span class="truncate font-medium">{{ title }}</span>
    </nav>

    <div class="ml-auto flex items-center gap-1">
      <!-- Command palette trigger -->
      <Button
        variant="outline"
        size="sm"
        class="hidden h-8 gap-2 px-2.5 text-muted-foreground sm:inline-flex"
        :aria-label="$t('shell.command.open')"
        @click="emit('open-command')"
      >
        <Search class="size-4" aria-hidden="true" />
        <span class="text-xs">{{ $t('shell.command.search') }}</span>
        <kbd
          class="pointer-events-none ml-1 inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
        >
          {{ $t('shell.command.shortcut') }}
        </kbd>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="sm:hidden"
        :aria-label="$t('shell.command.open')"
        @click="emit('open-command')"
      >
        <Search class="size-4" aria-hidden="true" />
      </Button>

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
              <p class="truncate font-mono text-sm font-medium">{{ accountLabel }}</p>
            </div>
            <Separator class="my-1" />
            <Button
              variant="ghost"
              class="w-full justify-start gap-2"
              @click="openSecurity"
            >
              <KeyRound class="size-4" aria-hidden="true" />
              {{ $t('shell.header.permissions') }}
            </Button>
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
