<script setup lang="ts">
/**
 * What a console route shows when the principal lacks every scope it needs
 * (router/accessModel). The address stays the one the operator followed, so
 * the page name and the missing scope are on screen instead of a silent jump
 * to Overview; the page itself never mounts, so it makes no calls it would
 * only be refused.
 */
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { LockKeyhole } from "lucide-vue-next";
import { Button } from "@/components/ui/button";

const props = defineProps<{ scopes: string[] }>();

const route = useRoute();
const { t, te } = useI18n();

const page = computed(() => {
  const name = typeof route.name === "string" ? route.name : "";
  return name && te(`nav.items.${name}`) ? t(`nav.items.${name}`) : route.path;
});
</script>

<template>
  <div class="p-4 sm:p-6" data-testid="route-denied">
    <section class="max-w-xl space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground">
      <div class="flex items-start gap-3">
        <LockKeyhole class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="min-w-0 space-y-2">
          <h1 class="text-base font-semibold tracking-tight">{{ $t('shell.denied.title', { page }) }}</h1>
          <p v-if="props.scopes.length === 1" class="text-sm text-muted-foreground">
            <i18n-t keypath="shell.denied.needsOne" tag="span" scope="global">
              <template #scope>
                <code class="rounded-sm border border-border px-1 py-0.5 font-mono text-xs text-foreground">{{ props.scopes[0] }}</code>
              </template>
            </i18n-t>
          </p>
          <template v-else>
            <p class="text-sm text-muted-foreground">{{ $t('shell.denied.needsAny') }}</p>
            <ul class="flex flex-wrap gap-1.5">
              <li v-for="scope in props.scopes" :key="scope" class="rounded-sm border border-border px-1 py-0.5 font-mono text-xs text-foreground">{{ scope }}</li>
            </ul>
          </template>
          <p class="text-sm text-muted-foreground">{{ $t('shell.denied.ask') }}</p>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 ps-8">
        <Button as-child size="sm">
          <RouterLink :to="{ name: 'overview' }">{{ $t('shell.denied.overview') }}</RouterLink>
        </Button>
        <Button as-child size="sm" variant="outline">
          <RouterLink :to="{ name: 'settings-security' }">{{ $t('shell.denied.permissions') }}</RouterLink>
        </Button>
      </div>
    </section>
  </div>
</template>
