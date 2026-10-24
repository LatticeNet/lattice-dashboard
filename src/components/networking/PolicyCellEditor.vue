<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RouteLocationRaw } from "vue-router";
import { RefreshCw } from "lucide-vue-next";
import type {
  GroupNetRule,
  GroupPolicyUpsertRequest,
  GroupPolicyView,
  MatrixGroup,
} from "@/lib/api";
import {
  assignRuleIds,
  draftPorts,
  ruleFieldError,
  type PolicyRuleDraft,
} from "@/views/networking/policyRuleModel";
import GroupChip from "./GroupChip.vue";
import PolicyDialogTitle from "./PolicyDialogTitle.vue";
import PolicyRulesEditor, { type InboundRuleLine, type PolicyRuleError } from "./PolicyRulesEditor.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  Dialog,
} from "@/components/ui/dialog";

/**
 * PolicyCellEditor authors the rules that govern one matrix cell: traffic from
 * the `source` group to the `dest` group. It edits ONLY the outbound rules
 * whose remote is `dest`; any other rules already on the source group's policy
 * (targeting other groups or external endpoints) are preserved untouched on
 * save, so editing one cell never clobbers another. Inbound rules for the cell
 * are kept and listed as not applied (design 32 D7): group policy compiles
 * outbound only, and a node policy holding an inbound rule cannot be planned.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    source: MatrixGroup;
    dest: MatrixGroup;
    /** Existing policy scoped to `source`, if one exists. */
    existing?: GroupPolicyView;
    /** How the page names `existing`, so the dialog says which policy Enabled and Priority belong to. */
    existingTitle?: string;
    saving?: boolean;
    canAdmin?: boolean;
    /** Where inbound traffic is managed; no link when the firewall page is absent. */
    firewallTo?: RouteLocationRaw | null;
    /**
     * Other outbound policies that reach the source group's nodes and hold
     * rules for this pair. This dialog edits only the source group's own
     * policy, so it names them rather than hiding them.
     */
    alsoFrom?: string[];
  }>(),
  { existing: undefined, existingTitle: undefined, saving: false, canAdmin: false, firewallTo: null, alsoFrom: () => [] },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", payload: GroupPolicyUpsertRequest): void;
}>();

const { t } = useI18n();

const meta = reactive({ enabled: true, priority: 0 });
const drafts = ref<PolicyRuleDraft[]>([]);
/** Rules on the source policy that target OTHER destinations. Preserved as-is. */
const otherRules = ref<GroupNetRule[]>([]);
/** Inbound rules for this cell: kept on save until removed, never applied. */
const inboundRules = ref<GroupNetRule[]>([]);
/** The cell held rules when opened, so saving with none left removes them. */
const hadDestRules = ref(false);

function isDestRule(r: GroupNetRule): boolean {
  return r.remote.kind === "group" && r.remote.group_id === props.dest.id;
}

function emptyDraft(): PolicyRuleDraft {
  return {
    action: "allow",
    protocol: "tcp",
    ports: "",
    comment: "",
    disabled: false,
  };
}

function ruleToDraft(r: GroupNetRule): PolicyRuleDraft {
  return {
    id: r.id,
    action: r.action,
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
    const destRules = rules.filter(isDestRule);
    hadDestRules.value = destRules.length > 0;
    inboundRules.value = destRules.filter((r) => r.direction === "ingress");
    const outbound = destRules.filter((r) => r.direction !== "ingress").map(ruleToDraft);
    drafts.value = outbound.length || inboundRules.value.length ? outbound : [emptyDraft()];
    meta.enabled = props.existing?.enabled ?? true;
    meta.priority = props.existing?.priority ?? 0;
  },
  { immediate: true },
);

function addRule() {
  drafts.value.push(emptyDraft());
}

function removeRule(index: number) {
  drafts.value.splice(index, 1);
}

function removeInbound(key: string) {
  inboundRules.value = inboundRules.value.filter((r) => r.id !== key);
}

const inboundLines = computed<InboundRuleLine[]>(() =>
  inboundRules.value.map((r) => ({
    key: r.id,
    text: `${r.action} ${r.protocol}${r.ports?.length ? `:${r.ports.join(",")}` : ""} ${t("networking.policyPage.direction.ingress")} ${props.dest.name}`,
  })),
);

function draftError(d: PolicyRuleDraft): PolicyRuleError | undefined {
  const field = ruleFieldError(d);
  if (!field) return undefined;
  if (field.key === "errAnyNoPorts") return { text: t("networking.policy.errAnyNoPorts"), ports: true };
  return { text: t(`networking.policy.${field.key}`, { token: field.token }), ports: true };
}

const errors = computed(() => drafts.value.map(draftError));
const hasErrors = computed(() => errors.value.some((e) => e !== undefined));
const canSubmit = computed(
  () => props.canAdmin && (drafts.value.length > 0 || hadDestRules.value) && !hasErrors.value,
);

/**
 * Saving turns the source group's policy on when it has none yet or is off.
 * Once planned, an enabled policy drops every outbound connection its rules
 * do not allow, so one allow rule for this cell cuts the group off from
 * everything else, the internet included; the dialog says so before save.
 */
const turnsPolicyOn = computed(
  () => meta.enabled && drafts.value.length > 0 && (!props.existing || !props.existing.enabled),
);

function onOpenChange(value: boolean) {
  emit("update:open", value);
}

function submit() {
  if (!canSubmit.value) return;
  const reserved = [...otherRules.value, ...inboundRules.value].map((r) => r.id);
  const ids = assignRuleIds(drafts.value, reserved, `grule_${props.dest.id}`);
  const destRules = drafts.value.map<GroupNetRule>((d, index) => ({
    id: ids[index]!,
    action: d.action,
    direction: "egress",
    protocol: d.protocol,
    ports: draftPorts(d),
    remote: { kind: "group", group_id: props.dest.id },
    ...(d.comment.trim() ? { comment: d.comment.trim() } : {}),
    ...(d.disabled ? { disabled: true } : {}),
  }));
  emit("save", {
    id: props.existing?.id,
    // The server replaces the whole record, so the name rides along.
    name: props.existing?.name,
    scope: { groups: [props.source.id] },
    rules: [...otherRules.value, ...destRules, ...inboundRules.value],
    enabled: meta.enabled,
    priority: meta.priority,
    // A save from a copy someone else replaced is refused, not written over theirs.
    version: props.existing?.version,
  });
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogScrollContent class="sm:max-w-2xl">
      <DialogHeader>
        <PolicyDialogTitle :editing="!!existing">
          <GroupChip :name="source.name" :color="source.color" pill />
          <span class="text-muted-foreground" aria-hidden="true">→</span>
          <span class="sr-only">{{ $t("networking.matrix.to") }}</span>
          <GroupChip :name="dest.name" :color="dest.color" pill />
        </PolicyDialogTitle>
        <DialogDescription>{{ $t("networking.matrix.editorDescription") }}</DialogDescription>
      </DialogHeader>
      <p v-if="alsoFrom.length" class="text-xs text-muted-foreground" data-testid="cell-also-from">
        {{ $t("networking.matrix.alsoFrom", { policies: alsoFrom.join(", ") }) }}
      </p>

      <form class="space-y-5" @submit.prevent="submit">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <!-- Enabled and Priority are the whole policy's, not this cell's. -->
          <p class="text-xs text-muted-foreground sm:col-span-2" data-testid="cell-whole-policy">
            {{
              existing
                ? $t("networking.matrix.wholePolicy", { policy: existingTitle ?? existing.label })
                : $t("networking.matrix.wholePolicyNew", { group: source.name })
            }}
          </p>
          <label class="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
            <input v-model="meta.enabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t("networking.matrix.policyEnabled") }}
          </label>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ $t("networking.matrix.priority") }}</Label>
            <Input v-model.number="meta.priority" type="number" />
          </div>
        </div>

        <p v-if="turnsPolicyOn" class="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-foreground" role="note">
          {{ $t("networking.matrix.createsPolicy", { group: source.name }) }}
        </p>

        <PolicyRulesEditor
          :rules="drafts"
          :errors="errors"
          :inbound="inboundLines"
          :firewall-to="firewallTo"
          :empty-text="$t('networking.matrix.noCellRules')"
          :can-edit="canAdmin"
          id-prefix="cell"
          @add="addRule"
          @remove="removeRule"
          @remove-inbound="removeInbound"
        />

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
