<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Construction } from "lucide-vue-next";
import PageHeader from "@/components/common/PageHeader.vue";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NAV } from "@/router/nav";

const route = useRoute();

const title = computed(() => (route.meta.title as string) || "Coming soon");
const section = computed(() => (route.meta.section as string) || "");

/** Resolve the section's nav icon so the placeholder feels in-context. */
const icon = computed(() => {
  const sec = NAV.find((s) => s.title === section.value);
  const item = sec?.items.find((i) => i.title === title.value);
  return item?.icon ?? Construction;
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="title"
      :description="section ? `${section} · part of the dashboard rebuild` : 'Part of the dashboard rebuild'"
    >
      <template #actions>
        <Badge variant="secondary">Planned</Badge>
      </template>
    </PageHeader>

    <Card class="lattice-grid relative overflow-hidden rounded-xl border shadow-sm">
      <div class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
        <div
          class="flex size-14 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs"
        >
          <component :is="icon" class="size-6" aria-hidden="true" />
        </div>
        <div class="space-y-1.5">
          <h2 class="text-lg font-semibold tracking-tight">{{ title }}</h2>
          <p class="mx-auto max-w-md text-sm text-muted-foreground">
            This panel is part of the dashboard rebuild and lands in an upcoming pass.
          </p>
        </div>
        <Badge variant="outline" class="gap-1.5">
          <span class="size-1.5 rounded-full bg-warning" />
          Coming soon in this rebuild
        </Badge>
      </div>
    </Card>
  </div>
</template>
