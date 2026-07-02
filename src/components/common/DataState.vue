<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Lock, WifiOff } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import EmptyState from "./EmptyState.vue";

const props = withDefaults(
  defineProps<{
    loading: boolean;
    error?: Error | null;
    isEmpty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    emptyTone?: "default" | "positive";
    /** When true, prior data exists; on error keep showing it with an inline banner. */
    hasData?: boolean;
    /** Opt out of last-good retention even when hasData is true. */
    keepLastGood?: boolean;
    skeletonRows?: number;
    class?: HTMLAttributes["class"];
  }>(),
  {
    error: null,
    isEmpty: false,
    emptyTitle: undefined,
    emptyDescription: undefined,
    emptyTone: "default",
    hasData: false,
    keepLastGood: true,
    skeletonRows: 3,
  },
);

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();

const rows = computed(() => Math.max(1, props.skeletonRows));

const apiError = computed(() =>
  props.error instanceof ApiError ? props.error : null,
);

const apiRequestId = computed(() => apiError.value?.requestId);

/** Classify a typed ApiError so each failure mode reads differently. */
const errorKind = computed<"gone" | "forbidden" | "offline" | "generic">(() => {
  const err = apiError.value;
  if (!err) return "generic";
  if (err.status === 404) return "gone";
  if (err.isForbidden) return "forbidden";
  if (err.status === 0 || err.code === "network_error") return "offline";
  return "generic";
});

/** Retain the last successful render instead of wiping it on a refresh failure. */
const showStale = computed(
  () => Boolean(props.error) && props.hasData && props.keepLastGood,
);

/** Caller-provided empty title, falling back to the shared default. */
const resolvedEmptyTitle = computed(
  () => props.emptyTitle ?? t("common.state.nothingHere"),
);

/** Title for the 404 "no longer exists" empty-style state. */
const goneTitle = computed(() => props.emptyTitle ?? t("common.state.gone"));

const errorMessage = computed(
  () => apiError.value?.serverMessage || props.error?.message || t("common.state.somethingWrong"),
);
</script>

<template>
  <div :class="cn(props.class)">
    <div v-if="loading" class="space-y-2">
      <Skeleton
        v-for="n in rows"
        :key="n"
        class="h-10 w-full rounded-md"
      />
    </div>

    <!-- Last-good retention: keep stale data, surface a small non-blocking banner. -->
    <div v-else-if="showStale" class="space-y-2">
      <div
        class="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2"
      >
        <p class="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle class="size-3.5 shrink-0 text-warning" />
          <span>{{ $t('common.state.couldNotRefresh') }}</span>
          <span v-if="apiRequestId" class="font-mono">
            · {{ $t('common.state.request') }} {{ apiRequestId }}
          </span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 px-2 text-xs"
          @click="emit('retry')"
        >
          {{ $t('common.actions.retry') }}
        </Button>
      </div>
      <slot />
    </div>

    <!-- 404: the resource is gone. Empty-style, no retry. -->
    <slot v-else-if="error && errorKind === 'gone'" name="empty">
      <EmptyState :title="goneTitle" :description="emptyDescription" />
    </slot>

    <!-- Forbidden: a quiet, non-destructive "no access" panel. -->
    <Card v-else-if="error && errorKind === 'forbidden'" class="border-border">
      <CardContent class="flex flex-col items-center gap-3 p-8 text-center">
        <div
          class="flex items-center justify-center rounded-full bg-muted p-3 text-muted-foreground"
        >
          <Lock class="size-5" />
        </div>
        <div class="space-y-1">
          <p class="text-sm font-medium text-foreground">
            {{ $t('common.state.noAccess') }}
          </p>
          <p
            v-if="apiRequestId"
            class="font-mono text-xs text-muted-foreground"
          >
            {{ $t('common.state.request') }} {{ apiRequestId }}
          </p>
        </div>
      </CardContent>
    </Card>

    <!-- Generic / offline destructive error card with retry. -->
    <Card
      v-else-if="error"
      class="border-destructive/40 bg-destructive/5"
    >
      <CardContent class="flex flex-col gap-3 p-4">
        <div class="flex items-start gap-2">
          <WifiOff
            v-if="errorKind === 'offline'"
            class="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <AlertTriangle
            v-else
            class="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div class="space-y-1">
            <p class="text-sm font-medium text-destructive">
              {{ errorKind === 'offline' ? $t('common.state.connectionLost') : errorMessage }}
            </p>
            <p
              v-if="apiRequestId"
              class="font-mono text-xs text-muted-foreground"
            >
              {{ $t('common.state.request') }} {{ apiRequestId }}
            </p>
          </div>
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            @click="emit('retry')"
          >
            {{ $t('common.actions.retry') }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <slot v-else-if="isEmpty" name="empty">
      <EmptyState
        :title="resolvedEmptyTitle"
        :description="emptyDescription"
        :tone="emptyTone"
      />
    </slot>

    <slot v-else />
  </div>
</template>
