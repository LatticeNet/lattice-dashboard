<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { api, unwrap, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";

import DataState from "./DataState.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The console's one node field. An operator recognises a node by its name and
 * by its id, so both are on the option.
 *
 * It never becomes an unusable control. Without `node:read`, after a failed
 * list, with an empty fleet, or when the bound id is not in the list, it falls
 * back to a plain id input and says why, instead of showing a Select with
 * nothing to pick.
 */
const props = withDefaults(
  defineProps<{
    /** DOM id of the control; the rendered label points at it. */
    id: string;
    /** Visible field label. Defaults to the shared "Node" label. */
    label?: string;
    /** Placeholder shown while nothing is selected. */
    placeholder?: string;
    disabled?: boolean;
    /** Why the field is locked. Surfaced on hover while disabled. */
    disabledReason?: string;
  }>(),
  {
    label: undefined,
    placeholder: undefined,
    disabled: false,
    disabledReason: undefined,
  },
);

const modelValue = defineModel<string>({ default: "" });

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("node:read"));

// One shot: the picker lives inside a form that is open for seconds, so there
// is nothing to poll for.
const nodesQuery = useAsyncData(
  () =>
    canRead.value
      ? api.nodes.list().then((r) => unwrap(r, "nodes"))
      : Promise.resolve([] as Node[]),
  { immediate: canRead.value },
);

const nodes = computed(() => nodesQuery.data.value ?? []);
const loaded = computed(() => nodesQuery.data.value !== undefined);

const fieldLabel = computed(() => props.label ?? t("common.nodePicker.label"));
const selectPlaceholder = computed(
  () => props.placeholder ?? t("common.nodePicker.placeholder"),
);

/** Why a list cannot be offered, or undefined when it can. */
const degradedReason = computed<string | undefined>(() => {
  if (!canRead.value) return t("common.nodePicker.needsScope");
  if (nodesQuery.error.value) return t("common.nodePicker.listFailed");
  if (!loaded.value) return undefined;
  if (nodes.value.length === 0) return t("common.nodePicker.noNodes");
  if (modelValue.value && !nodes.value.some((node) => node.id === modelValue.value)) {
    return t("common.nodePicker.unknownNode");
  }
  return undefined;
});
</script>

<template>
  <div class="grid gap-2">
    <Label :for="id">{{ fieldLabel }}</Label>
    <!--
      A form field always keeps a usable control, so `has-data` stays true and
      `is-empty` stays false: a failed list becomes DataState's compact banner
      above the id input rather than an error card where the field was, and an
      empty fleet degrades to that same input rather than an EmptyState.
    -->
    <DataState
      :loading="nodesQuery.loading.value"
      :error="nodesQuery.error.value"
      :has-data="true"
      :is-empty="false"
      :skeleton-rows="1"
      @retry="nodesQuery.refresh"
    >
      <Select v-if="!degradedReason" v-model="modelValue" :disabled="disabled">
        <SelectTrigger
          :id="id"
          class="w-full"
          :title="disabled ? disabledReason : undefined"
        >
          <SelectValue :placeholder="selectPlaceholder" />
        </SelectTrigger>
        <SelectContent>
          <!--
            The trigger renders the selected option as plain text, so two bare
            spans arrive concatenated: a name ending in "-NAT" followed by an id
            read as one word. The separator keeps the collapsed value legible
            without changing what the open list shows.
          -->
          <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
            <span>{{ node.name || node.id }}</span>
            <span class="font-mono text-xs text-muted-foreground"> · {{ shortId(node.id, 14) }}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      <Input
        v-else
        :id="id"
        v-model="modelValue"
        class="font-mono"
        autocomplete="off"
        :disabled="disabled"
        :title="disabled ? disabledReason : undefined"
        :placeholder="$t('common.nodePicker.idPlaceholder')"
      />
    </DataState>
    <p v-if="degradedReason" class="text-xs text-muted-foreground">{{ degradedReason }}</p>
  </div>
</template>
