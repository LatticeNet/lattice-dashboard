<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, Trash2 } from "lucide-vue-next";
import type {
  GroupNetRule,
  GroupPolicyUpsertRequest,
  GroupPolicyView,
  MatrixGroup,
  NetRuleAction,
  NetRuleDirection,
  NetRuleProtocol,
} from "@/lib/api";
import GroupChip from "./GroupChip.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
  Dialog,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * PolicyCellEditor authors the rules that govern one matrix cell: traffic from
 * the `source` group to the `dest` group. It edits ONLY the rules whose remote
 * is `dest`; any other rules already on the source group's policy (targeting
 * other groups or external endpoints) are preserved untouched on save, so
 * editing one cell never clobbers another.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    source: MatrixGroup;
    dest: MatrixGroup;
    direction: NetRuleDirection;
    /** Existing policy scoped to `source`, if one exists. */
    existing?: GroupPolicyView;
    saving?: boolean;
    canAdmin?: boolean;
  }>(),
  { existing: undefined, saving: false, canAdmin: false },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", payload: GroupPolicyUpsertRequest): void;
}>();

const { t } = useI18n();

interface RuleDraft {
  id?: string;
  action: NetRuleAction;
  direction: NetRuleDirection;
  protocol: NetRuleProtocol;
  ports: string;
  comment: string;
  disabled: boolean;
}

const meta = reactive({ enabled: true, priority: 0 });
const drafts = ref<RuleDraft[]>([]);
/** Rules on the source policy that target OTHER destinations — preserved as-is. */
const otherRules = ref<GroupNetRule[]>([]);

function isDestRule(r: GroupNetRule): boolean {
  return r.remote.kind === "group" && r.remote.group_id === props.dest.id;
}

function emptyDraft(): RuleDraft {
  return {
    action: "allow",
    direction: props.direction,
    protocol: "tcp",
    ports: "",
    comment: "",
    disabled: false,
  };
}

function ruleToDraft(r: GroupNetRule): RuleDraft {
  return {
    id: r.id,
    action: r.action,
    direction: r.direction,
    protocol: r.protocol,
    ports: (r.ports ?? []).join(", "),
    comment: r.comment ?? "",
    disabled: !!r.disabled,
  };
}

// Re-seed the form whenever the dialog opens for a new cell.
watch(
  () => [props.open, props.source.id, props.dest.id] as const,
  ([open]) => {
    if (!open) return;
    const rules = props.existing?.rules ?? [];
    otherRules.value = rules.filter((r) => !isDestRule(r));
    const destDrafts = rules.filter(isDestRule).map(ruleToDraft);
    drafts.value = destDrafts.length ? destDrafts : [emptyDraft()];
    meta.enabled = props.existing?.enabled ?? true;
    meta.priority = props.existing?.priority ?? 0;
  },
  { immediate: true },
);

function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) set.add(value);
  }
  return [...set].sort((a, b) => a - b);
}

function addRule() {
  drafts.value.push(emptyDraft());
}

function removeRule(index: number) {
  drafts.value.splice(index, 1);
}

function draftError(d: RuleDraft): string | undefined {
  if (d.protocol === "any" && parsePorts(d.ports).length > 0) {
    return t("networking.policy.errAnyNoPorts");
  }
  return undefined;
}

const errors = computed(() => drafts.value.map(draftError));
const hasErrors = computed(() => errors.value.some((e) => e !== undefined));
const canSubmit = computed(() => props.canAdmin && drafts.value.length > 0 && !hasErrors.value);

function draftToRule(d: RuleDraft, index: number): GroupNetRule {
  return {
    id: d.id || `grule_${props.dest.id}_${index + 1}`,
    action: d.action,
    direction: d.direction,
    protocol: d.protocol,
    ports: d.protocol === "any" ? [] : parsePorts(d.ports),
    remote: { kind: "group", group_id: props.dest.id },
    ...(d.comment.trim() ? { comment: d.comment.trim() } : {}),
    ...(d.disabled ? { disabled: true } : {}),
  };
}

function onOpenChange(value: boolean) {
  emit("update:open", value);
}

function submit() {
  if (!canSubmit.value) return;
  const destRules = drafts.value.map(draftToRule);
  emit("save", {
    id: props.existing?.id,
    scope_group_id: props.source.id,
    rules: [...otherRules.value, ...destRules],
    enabled: meta.enabled,
    priority: meta.priority,
  });
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogScrollContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex flex-wrap items-center gap-2">
          {{ $t("networking.matrix.editorTitle") }}
          <GroupChip :name="source.name" :color="source.color" pill />
          <span class="text-muted-foreground">→</span>
          <GroupChip :name="dest.name" :color="dest.color" pill />
        </DialogTitle>
        <DialogDescription>{{ $t("networking.matrix.editorDescription") }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-5" @submit.prevent="submit">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
            <input v-model="meta.enabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t("networking.matrix.policyEnabled") }}
          </label>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ $t("networking.matrix.priority") }}</Label>
            <Input v-model.number="meta.priority" type="number" />
          </div>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <Label>{{ $t("networking.policy.rules") }}</Label>
            <Button type="button" variant="outline" size="sm" :disabled="!canAdmin" @click="addRule">
              <Plus class="size-4" aria-hidden="true" />
              {{ $t("networking.policy.addRule") }}
            </Button>
          </div>

          <p
            v-if="drafts.length === 0"
            class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
          >
            {{ $t("networking.matrix.noCellRules") }}
          </p>

          <div
            v-for="(rule, index) in drafts"
            :key="index"
            class="space-y-3 rounded-lg border border-border p-3"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-muted-foreground">
                {{ $t("networking.policy.ruleLabel", { index: index + 1 }) }}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('networking.policy.removeRule')"
                @click="removeRule(index)"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>

            <div class="grid gap-3 sm:grid-cols-3">
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t("networking.policy.action") }}</Label>
                <Select v-model="rule.action">
                  <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">allow</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t("networking.policy.direction") }}</Label>
                <Select v-model="rule.direction">
                  <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="egress">egress</SelectItem>
                    <SelectItem value="ingress">ingress</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t("networking.policy.protocol") }}</Label>
                <Select v-model="rule.protocol">
                  <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">tcp</SelectItem>
                    <SelectItem value="udp">udp</SelectItem>
                    <SelectItem value="any">any</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t("networking.policy.ports") }}</Label>
                <Input
                  v-model="rule.ports"
                  :disabled="rule.protocol === 'any'"
                  :placeholder="$t('networking.policy.portsPlaceholder')"
                />
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t("networking.policy.comment") }}</Label>
                <Input v-model="rule.comment" :placeholder="$t('networking.policy.commentPlaceholder')" />
              </div>
            </div>

            <label class="flex items-center gap-2 text-sm">
              <input v-model="rule.disabled" type="checkbox" class="size-4 accent-primary" />
              {{ $t("networking.policy.disabled") }}
            </label>

            <p v-if="errors[index]" class="text-xs text-destructive">{{ errors[index] }}</p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="onOpenChange(false)">
            {{ $t("common.actions.cancel") }}
          </Button>
          <Button type="submit" :disabled="!canSubmit || saving">
            <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            {{ $t("networking.matrix.saveCell") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogScrollContent>
  </Dialog>
</template>
