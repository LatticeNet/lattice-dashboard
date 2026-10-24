<script setup lang="ts">
/**
 * The outbound rule list both policy dialogs edit (design 32 D3 and D7): the
 * node policy form and the group matrix cell editor. It says what an enabled
 * policy drops, edits each rule's action, protocol, ports, comment and state,
 * and leaves the remote to the caller through the `remote` slot, since a node
 * rule picks one and a matrix cell's remote is its destination group.
 *
 * Outbound policy compiles outbound rules only, so the form offers no
 * direction. Inbound rules a policy already holds are listed with what is
 * true of them per node (this plan never applies them; NetGuard-managed
 * nodes ignore them; on other nodes the legacy firewall and DNS plans still
 * apply them), a link to the firewall that owns inbound traffic and a remove
 * action: a policy holding one cannot be planned.
 */
import { nextTick, ref } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { AlertTriangle, Plus, Trash2 } from "lucide-vue-next";
import type { PolicyRuleDraft } from "@/views/networking/policyRuleModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface PolicyRuleError {
  text: string;
  /** The error is about the ports field, which is then marked invalid. */
  ports?: boolean;
}

export interface InboundRuleLine {
  key: string;
  text: string;
}

const props = withDefaults(
  defineProps<{
    rules: PolicyRuleDraft[];
    errors: (PolicyRuleError | undefined)[];
    /** Inbound rules the policy holds, kept on save and listed as not applied. */
    inbound?: InboundRuleLine[];
    /** Where inbound traffic is managed; no link when the firewall page is absent. */
    firewallTo?: RouteLocationRaw | null;
    emptyText: string;
    idPrefix: string;
    canEdit?: boolean;
    /**
     * The request path of the rules list (design 32 R6). When set, each rule
     * and its controls carry data-field paths ("rules[1].ports") so a refused
     * save marks the control it names; inbound lines follow the outbound
     * rules, in the order the editor sends them.
     */
    fieldPath?: string;
  }>(),
  { inbound: () => [], firewallTo: null, canEdit: true, fieldPath: undefined },
);

const emit = defineEmits<{
  (e: "add"): void;
  (e: "remove", index: number): void;
  (e: "remove-inbound", key: string): void;
}>();

/** Protocol any carries no ports, so switching to it clears the field it disables. */
function setProtocol(rule: PolicyRuleDraft, value: unknown) {
  if (value !== "tcp" && value !== "udp" && value !== "any") return;
  rule.protocol = value;
  if (value === "any") rule.ports = "";
}

function errorId(index: number): string {
  return `${props.idPrefix}-rule-${index}-error`;
}

/**
 * Removing a card or an inbound line unmounts the focused button, which drops
 * keyboard focus to the top of the dialog; it lands on Add rule instead.
 */
const addButton = ref<{ $el?: HTMLElement } | null>(null);
function remove(index: number) {
  emit("remove", index);
  void nextTick(() => addButton.value?.$el?.focus());
}
function removeInbound(key: string) {
  emit("remove-inbound", key);
  void nextTick(() => addButton.value?.$el?.focus());
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-2">
      <Label>{{ $t("networking.policy.rules") }}</Label>
      <Button ref="addButton" type="button" variant="outline" size="sm" :disabled="!canEdit" @click="emit('add')">
        <Plus class="size-4" aria-hidden="true" />
        {{ $t("networking.policy.addRule") }}
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">{{ $t("networking.policy.defaultDrop") }}</p>

    <div v-if="inbound.length" class="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-xs">
      <p class="flex items-start gap-2 text-sm font-medium text-foreground">
        <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        {{ $t("networking.policy.inboundTitle", { n: inbound.length }, inbound.length) }}
      </p>
      <p class="text-muted-foreground">{{ $t("networking.policy.inboundExplain") }}</p>
      <RouterLink
        v-if="firewallTo"
        :to="firewallTo"
        class="inline-flex min-h-8 items-center text-sm text-primary underline-offset-4 hover:underline"
      >
        {{ $t("networking.policy.openFirewall") }}
      </RouterLink>
      <ul class="divide-y divide-warning/20">
        <li
          v-for="(line, j) in inbound"
          :key="line.key"
          class="flex items-center justify-between gap-2 py-1"
          :data-field="fieldPath ? `${fieldPath}[${rules.length + j}]` : undefined"
        >
          <span class="min-w-0 break-words font-mono text-muted-foreground">{{ line.text }}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="!canEdit"
            :aria-label="$t('networking.policy.removeInboundRule', { rule: line.text })"
            @click="removeInbound(line.key)"
          >
            {{ $t("common.actions.remove") }}
          </Button>
        </li>
      </ul>
    </div>

    <p v-if="rules.length === 0" class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
      {{ emptyText }}
    </p>

    <div
      v-for="(rule, index) in rules"
      :key="index"
      role="group"
      :aria-label="$t('networking.policy.ruleLabel', { index: index + 1 })"
      class="space-y-3 rounded-lg border border-border p-3"
    >
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{{ $t("networking.policy.ruleLabel", { index: index + 1 }) }}</span>
        <Button type="button" variant="ghost" size="icon-sm" :aria-label="$t('networking.policy.removeRuleN', { index: index + 1 })" @click="remove(index)">
          <Trash2 class="size-4 text-destructive" />
        </Button>
      </div>

      <!-- The rule's own path sits on its fields, so a refusal about the rule as
           a whole focuses its first control rather than its remove button. -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3" :data-field="fieldPath ? `${fieldPath}[${index}]` : undefined">
        <div class="grid gap-1.5" :data-field="fieldPath ? `${fieldPath}[${index}].action` : undefined">
          <Label class="text-xs" :for="`${idPrefix}-rule-${index}-action`">{{ $t("networking.policy.action") }}</Label>
          <Select v-model="rule.action">
            <SelectTrigger :id="`${idPrefix}-rule-${index}-action`" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">allow</SelectItem>
              <SelectItem value="deny">deny</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1.5" :data-field="fieldPath ? `${fieldPath}[${index}].protocol` : undefined">
          <Label class="text-xs" :for="`${idPrefix}-rule-${index}-protocol`">{{ $t("networking.policy.protocol") }}</Label>
          <Select :model-value="rule.protocol" @update:model-value="(v) => setProtocol(rule, v)">
            <SelectTrigger :id="`${idPrefix}-rule-${index}-protocol`" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="tcp">tcp</SelectItem>
              <SelectItem value="udp">udp</SelectItem>
              <SelectItem value="any">any</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1.5" :data-field="fieldPath ? `${fieldPath}[${index}].ports` : undefined">
          <Label class="text-xs" :for="`${idPrefix}-rule-${index}-ports`">{{ $t("networking.policy.ports") }}</Label>
          <Input
            :id="`${idPrefix}-rule-${index}-ports`"
            v-model="rule.ports"
            inputmode="numeric"
            :disabled="rule.protocol === 'any'"
            :placeholder="rule.protocol === 'any' ? $t('networking.policy.portsAny') : $t('networking.policy.portsPlaceholder')"
            :aria-invalid="errors[index]?.ports ? 'true' : undefined"
            :aria-describedby="errors[index]?.ports ? errorId(index) : undefined"
          />
          <!-- Under the field it is about, and announced, so a phone keyboard
               does not hide why Save went grey. -->
          <p :id="errorId(index)" aria-live="polite" class="text-xs text-destructive empty:hidden">{{ errors[index]?.ports ? errors[index]?.text : "" }}</p>
        </div>
      </div>

      <slot name="remote" :rule="rule" :index="index" />

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5" :data-field="fieldPath ? `${fieldPath}[${index}].comment` : undefined">
          <Label class="text-xs" :for="`${idPrefix}-rule-${index}-comment`">{{ $t("networking.policy.comment") }}</Label>
          <Input :id="`${idPrefix}-rule-${index}-comment`" v-model="rule.comment" :placeholder="$t('networking.policy.commentPlaceholder')" />
        </div>
        <label class="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
          <Checkbox v-model="rule.disabled" />
          {{ $t("networking.policy.disabled") }}
        </label>
      </div>

      <p v-if="errors[index] && !errors[index]?.ports" class="text-xs text-destructive" aria-live="polite">{{ errors[index]?.text }}</p>
    </div>
  </div>
</template>
