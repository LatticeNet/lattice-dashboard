<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
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
    skeletonRows?: number;
    class?: HTMLAttributes["class"];
  }>(),
  {
    error: null,
    isEmpty: false,
    emptyTitle: undefined,
    emptyDescription: undefined,
    skeletonRows: 3,
  },
);

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();

const rows = computed(() => Math.max(1, props.skeletonRows));

const apiRequestId = computed(() =>
  props.error instanceof ApiError ? props.error.requestId : undefined,
);

/** Caller-provided empty title, falling back to the shared default. */
const resolvedEmptyTitle = computed(
  () => props.emptyTitle ?? t("common.state.nothingHere"),
);

const errorMessage = computed(
  () => props.error?.message || t("common.state.somethingWrong"),
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

    <Card
      v-else-if="error"
      class="border-destructive/40 bg-destructive/5"
    >
      <CardContent class="flex flex-col gap-3 p-4">
        <div class="space-y-1">
          <p class="text-sm font-medium text-destructive">
            {{ errorMessage }}
          </p>
          <p
            v-if="apiRequestId"
            class="font-mono text-xs text-muted-foreground"
          >
            {{ $t('common.state.request') }} {{ apiRequestId }}
          </p>
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
      />
    </slot>

    <slot v-else />
  </div>
</template>
