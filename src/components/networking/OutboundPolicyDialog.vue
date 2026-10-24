<script setup lang="ts">
/**
 * Create or edit one outbound policy (design 32 D3): a name, a target chosen
 * with the shared selector (one node, several nodes, node groups or the whole
 * fleet are all one policy), priority, state, and the outbound rules, whose
 * remote may be a node group that expands to its members' addresses when the
 * plan compiles.
 *
 * Saving stores the definition only; nothing reaches a node until the
 * outbound policies are planned and each node's plan is approved. Inbound
 * rules a policy still holds are kept and listed as not applied, with a
 * remove action, the way the node form and the matrix editor list them.
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RouteLocationRaw } from "vue-router";
import { RefreshCw } from "lucide-vue-next";

import type { GroupNetRule, GroupPolicyUpsertRequest, GroupPolicyView, GroupView, Node, TargetSelector } from "@/lib/api";
import SelectorPicker from "@/components/selector/SelectorPicker.vue";
import { isEmptySelector, normalizeSelector, selectorParts } from "@/components/selector/selectorModel";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogScrollContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignRuleIds, ruleFieldError } from "@/views/networking/policyRuleModel";
import {
  editsRemoteKind,
  emptyOutboundRule,
  outboundDraftToRule,
  remoteProblem,
  ruleToOutboundDraft,
  type OutboundRuleDraft,
} from "@/views/networking/outboundPolicyModel";
import PolicyDialogTitle from "./PolicyDialogTitle.vue";
import PolicyRulesEditor, { type InboundRuleLine, type PolicyRuleError } from "./PolicyRulesEditor.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The policy being edited; a new one when absent. */
    existing?: GroupPolicyView;
    nodes: Node[];
    groups: GroupView[];
    saving?: boolean;
    canAdmin?: boolean;
    /** The session is confined to some nodes: only explicit nodes it administers, no groups. */
    restricted?: boolean;
    /** Where inbound traffic is managed; no link when the firewall page is absent. */
    firewallTo?: RouteLocationRaw | null;
  }>(),
  { existing: undefined, saving: false, canAdmin: false, restricted: false, firewallTo: null },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", payload: GroupPolicyUpsertRequest): void;
}>();

const { t } = useI18n();

const form = reactive<{ name: string; target: TargetSelector; enabled: boolean; priority: number; rules: OutboundRuleDraft[] }>({
  name: "",
  target: {},
  enabled: true,
  priority: 0,
  rules: [],
});
/** Inbound rules the policy holds: kept on save until removed, never applied. */
const inbound = ref<GroupNetRule[]>([]);

function snapshot(): string {
  return JSON.stringify({ ...form, target: normalizeSelector(form.target), inbound: inbound.value.map((r) => r.id) });
}
const opened = ref("");
const dirty = computed(() => props.open && snapshot() !== opened.value);
const discardOpen = ref(false);

watch(
  () => [props.open, props.existing?.id] as const,
  ([open]) => {
    if (!open) return;
    const p = props.existing;
    form.name = p?.name ?? "";
    form.target = normalizeSelector(p?.target ?? {});
    form.enabled = p?.enabled ?? true;
    form.priority = p?.priority ?? 0;
    const rules = p?.rules ?? [];
    inbound.value = rules.filter((r) => r.direction === "ingress");
    const outbound = rules.filter((r) => r.direction !== "ingress").map(ruleToOutboundDraft);
    form.rules = outbound.length || inbound.value.length ? outbound : [emptyOutboundRule()];
    opened.value = snapshot();
  },
  { immediate: true },
);

function requestClose(): void {
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  emit("update:open", false);
}

function onOpenChange(value: boolean): void {
  if (value) emit("update:open", true);
  else requestClose();
}

function discard(): void {
  discardOpen.value = false;
  emit("update:open", false);
}

const groupNames = computed(() => new Map(props.groups.map((g) => [g.id, g.name])));
function nodeName(id: string): string {
  return props.nodes.find((n) => n.id === id)?.name || id;
}

const inboundLines = computed<InboundRuleLine[]>(() =>
  inbound.value.map((r) => {
    const remote = r.remote.kind === "group" ? groupNames.value.get(r.remote.group_id ?? "") ?? r.remote.group_id : r.remote.kind === "node" ? nodeName(r.remote.node_id ?? "") : (r.remote.cidr ?? r.remote.domain ?? r.remote.kind);
    return { key: r.id, text: `${r.action} ${r.protocol}${r.ports?.length ? `:${r.ports.join(",")}` : ""} ${t("networking.policyPage.direction.ingress")} ${remote}` };
  }),
);

function ruleError(draft: OutboundRuleDraft): PolicyRuleError | undefined {
  const field = ruleFieldError(draft);
  if (field) {
    if (field.key === "errAnyNoPorts") return { text: t("networking.policy.errAnyNoPorts"), ports: true };
    return { text: t(`networking.policy.${field.key}`, { token: field.token }), ports: true };
  }
  const remote = remoteProblem(draft);
  if (remote) return { text: t(`networking.policy.${remote}`) };
  if (props.restricted && draft.remoteKind === "group") return { text: t("networking.outbound.restrictedRemoteGroup") };
  return undefined;
}

const errors = computed(() => form.rules.map(ruleError));
const noTarget = computed(() => isEmptySelector(form.target));
const canSubmit = computed(() => props.canAdmin && !noTarget.value && errors.value.every((e) => e === undefined));

/** What the title names after the verb: the name, or the target in a few words. */
const titleObject = computed(() => {
  if (form.name.trim()) return form.name.trim();
  const parts = selectorParts(form.target, props.nodes, props.groups);
  if (parts.length === 0) return "";
  const words = parts.slice(0, 3).map((part) =>
    part.kind === "fleet" ? t("selector.wholeFleetInline") : part.kind === "exclude" ? t("selector.except", { name: part.name }) : part.name,
  );
  return parts.length > 3 ? `${words.join(", ")} +${parts.length - 3}` : words.join(", ");
});

function addRule(): void {
  form.rules.push(emptyOutboundRule());
}
function removeRule(index: number): void {
  form.rules.splice(index, 1);
}
function removeInbound(key: string): void {
  inbound.value = inbound.value.filter((r) => r.id !== key);
}

function submit(): void {
  if (!canSubmit.value) return;
  const ids = assignRuleIds(form.rules, inbound.value.map((r) => r.id), "rule");
  emit("save", {
    id: props.existing?.id,
    name: form.name.trim() || undefined,
    scope: normalizeSelector(form.target),
    rules: [...form.rules.map((draft, i) => outboundDraftToRule(draft, ids[i]!)), ...inbound.value],
    enabled: form.enabled,
    priority: Number.isFinite(form.priority) ? Math.trunc(form.priority) : 0,
  });
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogScrollContent class="sm:max-w-3xl">
      <DialogHeader>
        <PolicyDialogTitle :editing="!!existing">
          <!-- A conditional slot, so the title drops its separator while nothing is chosen; the text wraps, so a long name never widens the dialog past a phone screen. -->
          <template v-if="titleObject" #default>
            <span class="min-w-0 wrap-anywhere">{{ titleObject }}</span>
          </template>
        </PolicyDialogTitle>
        <DialogDescription>{{ $t("networking.outbound.formDescription") }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-5" @submit.prevent="submit">
        <div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_10rem]">
          <div class="grid gap-1.5">
            <Label for="outbound-name">{{ $t("networking.outbound.name") }}</Label>
            <Input id="outbound-name" v-model="form.name" :placeholder="$t('networking.outbound.namePlaceholder')" maxlength="120" />
          </div>
          <div class="grid gap-1.5">
            <Label for="outbound-priority">{{ $t("networking.matrix.priority") }}</Label>
            <Input id="outbound-priority" v-model.number="form.priority" type="number" inputmode="numeric" aria-describedby="outbound-priority-hint" />
          </div>
          <div class="grid gap-1.5">
            <span class="text-sm font-medium leading-none">{{ $t("networking.policy.policyState") }}</span>
            <label class="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm">
              <Checkbox v-model="form.enabled" />
              {{ $t("networking.policy.enabled") }}
            </label>
          </div>
          <p id="outbound-priority-hint" class="text-xs text-muted-foreground sm:col-span-3">{{ $t("networking.outbound.priorityHint") }}</p>
        </div>

        <fieldset class="grid gap-2">
          <legend class="mb-1 text-sm font-medium">{{ $t("networking.outbound.target") }}</legend>
          <SelectorPicker
            v-model="form.target"
            :nodes="nodes"
            :groups="groups"
            :label="$t('networking.outbound.target')"
            :allow-groups="!restricted"
            :allow-fleet="!restricted"
            :restricted-reason="restricted ? $t('networking.outbound.restrictedTarget') : ''"
            id-prefix="outbound-target"
          />
        </fieldset>

        <PolicyRulesEditor
          :rules="form.rules"
          :errors="errors"
          :inbound="inboundLines"
          :firewall-to="firewallTo"
          :empty-text="$t('networking.policy.noRules')"
          :can-edit="canAdmin"
          id-prefix="outbound"
          @add="addRule"
          @remove="removeRule"
          @remove-inbound="removeInbound"
        >
          <template #remote="{ index }">
            <!-- Top-aligned: the group hint makes its cell taller than the kind's. -->
            <div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs" :for="`outbound-rule-${index}-remote`">{{ $t("networking.policy.remoteKind") }}</Label>
                <Select v-model="form.rules[index]!.remoteKind">
                  <SelectTrigger :id="`outbound-rule-${index}-remote`" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="node">{{ $t("networking.outbound.remoteKind.node") }}</SelectItem>
                    <SelectItem value="group" :disabled="restricted">{{ $t("networking.outbound.remoteKind.group") }}</SelectItem>
                    <SelectItem value="cidr">{{ $t("networking.outbound.remoteKind.cidr") }}</SelectItem>
                    <SelectItem value="domain">{{ $t("networking.outbound.remoteKind.domain") }}</SelectItem>
                    <SelectItem value="any">{{ $t("networking.outbound.remoteKind.any") }}</SelectItem>
                    <SelectItem v-if="!editsRemoteKind(form.rules[index]!.remoteKind)" :value="form.rules[index]!.remoteKind" disabled>
                      {{ $t("networking.policy.remoteKept", { kind: form.rules[index]!.remoteKind }) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="form.rules[index]!.remoteKind === 'node'" class="grid gap-1.5">
                <Label class="text-xs" :for="`outbound-rule-${index}-node`">{{ $t("networking.policy.remoteNode") }}</Label>
                <Select v-model="form.rules[index]!.remoteNodeId">
                  <SelectTrigger :id="`outbound-rule-${index}-node`" class="w-full"><SelectValue :placeholder="$t('networking.policy.selectNode')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name || node.id }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-else-if="form.rules[index]!.remoteKind === 'group'" class="grid gap-1.5">
                <Label class="text-xs" :for="`outbound-rule-${index}-group`">{{ $t("networking.outbound.remoteGroup") }}</Label>
                <Select v-model="form.rules[index]!.remoteGroupId">
                  <SelectTrigger :id="`outbound-rule-${index}-group`" class="w-full"><SelectValue :placeholder="$t('networking.outbound.selectGroup')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ $t("networking.outbound.remoteGroupHint") }}</p>
              </div>
              <div v-else-if="form.rules[index]!.remoteKind === 'cidr'" class="grid gap-1.5">
                <Label class="text-xs" :for="`outbound-rule-${index}-cidr`">{{ $t("networking.policy.remoteCidr") }}</Label>
                <Input :id="`outbound-rule-${index}-cidr`" v-model="form.rules[index]!.remoteCidr" placeholder="10.0.0.0/24 or 1.2.3.4" />
              </div>
              <div v-else-if="form.rules[index]!.remoteKind === 'domain'" class="grid gap-1.5">
                <Label class="text-xs" :for="`outbound-rule-${index}-domain`">{{ $t("networking.policy.remoteDomain") }}</Label>
                <Input :id="`outbound-rule-${index}-domain`" v-model="form.rules[index]!.remoteDomain" placeholder="api.example.com" />
              </div>
            </div>
          </template>
        </PolicyRulesEditor>

        <!-- The footer stacks in reverse below sm, so the note comes last in the
             markup to sit above the disabled Create on a phone and first
             (order-first) beside the buttons on wider screens. -->
        <DialogFooter class="sm:items-center">
          <Button type="button" variant="outline" @click="requestClose">{{ $t("common.actions.cancel") }}</Button>
          <Button type="submit" :disabled="!canSubmit || saving">
            <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            {{ existing ? $t("common.actions.saveChanges") : $t("networking.outbound.create") }}
          </Button>
          <p v-if="noTarget" class="text-xs text-muted-foreground sm:order-first sm:me-auto" data-testid="outbound-missing">{{ $t("networking.outbound.stillNeedsTarget") }}</p>
        </DialogFooter>
      </form>
    </DialogScrollContent>
  </Dialog>

  <ConfirmDialog
    :open="discardOpen"
    variant="destructive"
    :title="$t('networking.policy.discardTitle')"
    :description="$t('networking.policy.discardDescription')"
    :confirm-label="$t('networking.policy.discardConfirm')"
    :cancel-label="$t('common.actions.cancel')"
    @update:open="(v) => { if (!v) discardOpen = false; }"
    @confirm="discard"
  />
</template>
