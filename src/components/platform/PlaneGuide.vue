<script setup lang="ts">
/**
 * The guide at the top of Store and Publishing (DESIGN-PROGRAM-2026-09 §9,
 * Decision B). Open while the plane is empty, one line once it is not, and the
 * operator's own toggle remembered per browser under a lattice.ui key.
 *
 * The four blocks are fixed by the design in this order: what the page is (the
 * one sentence the caller passes, because it differs per page), how Store and
 * Publishing relate, who writes here today besides this console, and the
 * walkthrough whose steps link to the exact controls. Every sentence is a
 * claim about the code: the caller list is the one verified against the
 * plugin manifests, and the binding step comes before the fetch step because
 * server_storage.go refuses a binding for a bucket with no record.
 */
import { computed, ref, watch } from "vue";
import { BookOpen, ChevronDown } from "lucide-vue-next";
import { RouterLink, type RouteLocationRaw } from "vue-router";

import { cn } from "@/lib/utils";
import { guideExpanded, guideStorageKey, guideStoredValue, type GuidePage } from "./planeGuideModel";

const props = defineProps<{
  page: GuidePage;
  /** Whether the plane this page shows has nothing on it yet. Decides the default only. */
  planeEmpty: boolean;
  title: string;
  /** The one-sentence "what this is", which is the only block that differs per page. */
  what: string;
}>();

function readStored(): string | null {
  try {
    return localStorage.getItem(guideStorageKey(props.page));
  } catch {
    return null;
  }
}

const stored = ref<string | null>(readStored());
const expanded = computed(() => guideExpanded(stored.value, props.planeEmpty));

function toggle() {
  const next = guideStoredValue(!expanded.value);
  stored.value = next;
  try {
    localStorage.setItem(guideStorageKey(props.page), next);
  } catch {
    // A browser that refuses storage still gets the toggle for this visit.
  }
}

// The page can be swapped under this component (Store re-uses one instance
// across kinds); re-read the choice when it is.
watch(() => props.page, () => {
  stored.value = readStored();
});

const bodyId = computed(() => `plane-guide-${props.page}`);

/** The Publishing lens a step opens on, with the card it points at. */
function publishingControl(origin: "kv" | "static", card: "buckets" | "bindings" | "tokens"): RouteLocationRaw {
  return { path: "/platform/publishing", query: { origin }, hash: `#publishing-${card}` };
}

const steps = computed<{ key: string; to: RouteLocationRaw }[]>(() => [
  { key: "bucket", to: publishingControl("static", "buckets") },
  { key: "object", to: { path: "/platform/store", query: { kind: "static" } } },
  { key: "binding", to: publishingControl("static", "bindings") },
  { key: "fetch", to: publishingControl("kv", "tokens") },
]);
</script>

<template>
  <section class="rounded-md border border-border" :aria-label="title">
    <div class="flex min-h-10 items-center gap-3 px-4 py-2">
      <BookOpen aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <h2 class="shrink-0 text-sm font-medium">{{ title }}</h2>
      <!-- Collapsed is one line: the title and the sentence, nothing else. On a
           phone the title and the toggle leave the sentence about ten pixels,
           which rendered as its first letter, so there the line is title and
           toggle only; the sentence is a tap away. -->
      <p v-if="!expanded" class="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block" :title="what">{{ what }}</p>
      <!-- ml-auto keeps the toggle at the right edge whether the sentence is
           there to fill the row or not. -->
      <button
        type="button"
        class="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        @click="toggle"
      >
        {{ expanded ? $t('platform.publishing.guide.hide') : $t('platform.publishing.guide.show') }}
        <ChevronDown aria-hidden="true" :class="cn('size-4 transition-transform', expanded && 'rotate-180')" />
      </button>
    </div>

    <div v-if="expanded" :id="bodyId" class="space-y-5 border-t border-border px-4 py-4 text-sm">
      <p class="leading-relaxed">{{ what }}</p>

      <dl class="grid gap-4 lg:grid-cols-2">
        <div>
          <dt class="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {{ $t('platform.publishing.guide.relationLabel') }}
          </dt>
          <dd class="mt-1 leading-relaxed">{{ $t('platform.publishing.guide.relation') }}</dd>
        </div>
        <div>
          <dt class="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {{ $t('platform.publishing.guide.writersLabel') }}
          </dt>
          <dd class="mt-1">
            <ul class="space-y-1 leading-relaxed">
              <li v-for="origin in ['kv', 'static', 'share']" :key="origin" class="flex gap-2">
                <span class="w-12 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
                  {{ $t(`platform.publishing.guide.writers.${origin}Label`) }}
                </span>
                <span class="min-w-0">{{ $t(`platform.publishing.guide.writers.${origin}`) }}</span>
              </li>
            </ul>
          </dd>
        </div>
      </dl>

      <div>
        <p class="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          {{ $t('platform.publishing.guide.walkthroughLabel') }}
        </p>
        <ol class="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <li
            v-for="(step, index) in steps"
            :key="step.key"
            class="flex gap-3 rounded-md border border-border bg-muted/20 p-3"
          >
            <span class="font-mono text-xs tabular leading-5 text-muted-foreground">{{ String(index + 1).padStart(2, '0') }}</span>
            <div class="min-w-0 space-y-1">
              <p class="font-medium">{{ $t(`platform.publishing.guide.steps.${step.key}.title`) }}</p>
              <p class="text-xs leading-relaxed text-muted-foreground">
                {{ $t(`platform.publishing.guide.steps.${step.key}.detail`) }}
              </p>
              <RouterLink
                :to="step.to"
                class="inline-block rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >{{ $t(`platform.publishing.guide.steps.${step.key}.link`) }}</RouterLink>
            </div>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>
