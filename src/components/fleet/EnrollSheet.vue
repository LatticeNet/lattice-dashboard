<script setup lang="ts">
/**
 * Enroll a node (design 23, 4.2: Enroll moves from an inline card in the
 * daily path to the header). The sheet holds the form, then the install
 * command the new agent runs; the token in it is shown once.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { ChevronDown, Plus, RefreshCw } from "lucide-vue-next";

import { api, type AgentLaunchConfig, type EnrollTokenResponse, type GroupView } from "@/lib/api";
import { groupColor } from "@/lib/groupColors";
import { cn } from "@/lib/utils";

import ObjectSheet from "@/components/common/ObjectSheet.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ShellText from "@/components/common/ShellText.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const props = defineProps<{ open: boolean; groups: readonly GroupView[] }>();
const emit = defineEmits<{ close: []; enrolled: [] }>();

const { t } = useI18n();

const name = ref("");
const nodeId = ref("");
const role = ref("");
const tags = ref("");
const comment = ref("");
const sourceAllowlist = ref("");
const groupIds = ref<string[]>([]);
const advancedOpen = ref(false);
const allowExec = ref(false);
const allowRootExec = ref(false);
const noExec = ref(false);
const allowTerminal = ref(false);
const terminalTransport = ref<"poll" | "stream">("stream");
const sshAlerts = ref(false);
const pending = ref(false);
const result = ref<EnrollTokenResponse | undefined>();
const platform = ref<"linux" | "manual">("linux");

// A reopened sheet starts on the form, not on the last node's one-time token.
watch(
  () => props.open,
  (open) => {
    if (open) result.value = undefined;
  },
);

function reset(): void {
  name.value = "";
  nodeId.value = "";
  role.value = "";
  tags.value = "";
  comment.value = "";
  sourceAllowlist.value = "";
  groupIds.value = [];
  allowExec.value = false;
  allowRootExec.value = false;
  noExec.value = false;
  allowTerminal.value = false;
  terminalTransport.value = "stream";
  sshAlerts.value = false;
}

function toggleGroup(id: string): void {
  const next = new Set(groupIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  groupIds.value = [...next];
}

function launch(): AgentLaunchConfig {
  return {
    allow_exec: allowExec.value,
    allow_root_exec: allowRootExec.value,
    no_exec: noExec.value,
    allow_terminal: allowTerminal.value,
    terminal_transport: allowTerminal.value ? terminalTransport.value : undefined,
    ssh_alerts: sshAlerts.value,
  };
}

async function submit(): Promise<void> {
  if (!name.value.trim()) return;
  pending.value = true;
  result.value = undefined;
  try {
    result.value = await api.nodes.enrollToken({
      node_id: nodeId.value.trim() || undefined,
      name: name.value.trim(),
      role: role.value.trim() || undefined,
      tags: tags.value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
      comment: comment.value.trim() || undefined,
      agent_source_allowlist: sourceAllowlist.value
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
      group_ids: groupIds.value.length ? [...groupIds.value] : undefined,
      agent_launch: launch(),
    });
    reset();
    toast.success(t("fleet.nodes.toast.tokenCreated"));
    emit("enrolled");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.enrollFailed"));
  } finally {
    pending.value = false;
  }
}

/**
 * Something typed or chosen that closing would throw away. Escape, the close
 * button and Close ask first when it is set, like the Machines editor. Once
 * the token is created the form is empty again and nothing is owed.
 */
const dirty = computed(
  () =>
    [name, nodeId, role, tags, comment, sourceAllowlist].some((field) => field.value.trim() !== "") ||
    groupIds.value.length > 0 ||
    allowExec.value ||
    allowRootExec.value ||
    noExec.value ||
    allowTerminal.value ||
    sshAlerts.value ||
    terminalTransport.value !== "stream",
);
const discardOpen = ref(false);
function requestClose(): void {
  if (pending.value) return;
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  emit("close");
}
function discard(): void {
  discardOpen.value = false;
  reset();
  emit("close");
}

const command = computed(() => {
  if (!result.value) return "";
  return result.value.commands?.[platform.value] || result.value.command || result.value.token;
});

const CHOICE =
  "flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm";
</script>

<template>
  <ObjectSheet :open="open" :title="$t('fleet.nodes.enroll.title')" @close="requestClose">
    <div class="space-y-5">
      <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.enroll.description') }}</p>

      <!-- The one-time command, once there is one. -->
      <div v-if="result" class="grid gap-3 rounded-md border border-success/40 bg-success/5 p-4" role="status">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium">{{ $t('fleet.nodes.enroll.tokenFor', { id: result.node_id }) }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.tokenHint') }}</p>
          </div>
          <CopyButton :value="command" :label="$t('fleet.nodes.enroll.copyCommand')" />
        </div>
        <div class="inline-flex w-fit rounded-md border border-border bg-background/70 p-0.5" role="group">
          <button
            v-for="choice in ['linux', 'manual'] as const"
            :key="choice"
            type="button"
            :class="cn(
              'rounded px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
              platform === choice ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )"
            :aria-pressed="platform === choice"
            @click="platform = choice"
          >
            {{ choice === 'linux' ? $t('fleet.nodes.enroll.platformLinux') : $t('fleet.nodes.enroll.platformManual') }}
          </button>
        </div>
        <code class="block overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-3 font-mono text-xs"><ShellText v-if="platform === 'linux'" :text="command" /><template v-else>{{ command }}</template></code>
      </div>

      <form id="enroll-form" class="grid grid-cols-1 gap-3 sm:grid-cols-2" @submit.prevent="submit">
        <div class="grid gap-1.5">
          <Label for="enroll-name">{{ $t('fleet.nodes.enroll.name') }}</Label>
          <Input id="enroll-name" v-model="name" required autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <Label for="enroll-id">{{ $t('fleet.nodes.enroll.nodeId') }}</Label>
          <Input id="enroll-id" v-model="nodeId" :placeholder="$t('common.misc.optional')" autocomplete="off" />
        </div>
        <div class="grid gap-1.5">
          <Label for="enroll-role">{{ $t('fleet.nodes.enroll.role') }}</Label>
          <Input id="enroll-role" v-model="role" :placeholder="$t('fleet.nodes.enroll.rolePlaceholder')" />
        </div>
        <div class="grid gap-1.5">
          <Label for="enroll-tags">{{ $t('fleet.nodes.enroll.tags') }}</Label>
          <Input id="enroll-tags" v-model="tags" :placeholder="$t('fleet.nodes.enroll.tagsPlaceholder')" />
        </div>
        <div class="grid gap-1.5 sm:col-span-2">
          <Label for="enroll-comment">{{ $t('fleet.nodes.enroll.comment') }}</Label>
          <Input id="enroll-comment" v-model="comment" :placeholder="$t('common.misc.optional')" />
        </div>
        <div class="grid gap-1.5 sm:col-span-2">
          <Label for="enroll-source">{{ $t('fleet.nodes.enroll.agentSourceAllowlist') }}</Label>
          <Textarea id="enroll-source" v-model="sourceAllowlist" rows="2" :placeholder="$t('fleet.nodes.enroll.agentSourceAllowlistPlaceholder')" />
          <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.agentSourceAllowlistHint') }}</p>
        </div>
      </form>

      <div v-if="groups.length" class="grid gap-1.5">
        <Label>{{ $t('fleet.nodes.enroll.groups') }}</Label>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.groupsHint') }}</p>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="group in groups"
            :key="group.id"
            type="button"
            :class="cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors pointer-coarse:min-h-11',
              groupIds.includes(group.id)
                ? cn(groupColor(group.color).border, groupColor(group.color).soft, groupColor(group.color).text)
                : 'border-border text-muted-foreground hover:bg-muted/40',
            )"
            :aria-pressed="groupIds.includes(group.id)"
            @click="toggleGroup(group.id)"
          >
            <span :class="cn('size-2 shrink-0 rounded-[2px]', groupColor(group.color).dot)" aria-hidden="true" />
            {{ group.name }}
          </button>
        </div>
      </div>

      <div class="rounded-lg border border-border">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-expanded="advancedOpen"
          @click="advancedOpen = !advancedOpen"
        >
          <span>
            <span class="block text-sm font-medium">{{ $t('fleet.nodes.enroll.agentProfile') }}</span>
            <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.agentProfileHint') }}</span>
          </span>
          <ChevronDown :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')" aria-hidden="true" />
        </button>
        <div v-if="advancedOpen" class="grid grid-cols-1 gap-2 border-t border-border bg-muted/20 p-3 sm:grid-cols-2">
          <label :class="CHOICE">
            <Checkbox v-model="allowExec" class="mt-0.5" :disabled="noExec" />
            <span>
              <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowExec') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowExecHint') }}</span>
            </span>
          </label>
          <label :class="CHOICE">
            <Checkbox v-model="allowRootExec" class="mt-0.5" :disabled="noExec || !allowExec" />
            <span>
              <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowRootExec') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowRootExecHint') }}</span>
            </span>
          </label>
          <label :class="CHOICE">
            <Checkbox v-model="noExec" class="mt-0.5" />
            <span>
              <span class="block font-medium">{{ $t('fleet.nodes.enroll.noExec') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.noExecHint') }}</span>
            </span>
          </label>
          <label :class="CHOICE">
            <Checkbox v-model="allowTerminal" class="mt-0.5" :disabled="noExec" />
            <span>
              <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowTerminal') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowTerminalHint') }}</span>
            </span>
          </label>
          <label :class="CHOICE">
            <Checkbox v-model="sshAlerts" class="mt-0.5" />
            <span>
              <span class="block font-medium">{{ $t('fleet.nodes.enroll.sshAlerts') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.sshAlertsHint') }}</span>
            </span>
          </label>
          <div class="grid gap-1.5">
            <Label>{{ $t('fleet.nodes.enroll.terminalTransport') }}</Label>
            <Select v-model="terminalTransport" :disabled="!allowTerminal">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="poll">poll</SelectItem>
                <SelectItem value="stream">stream</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>

    <template #actions>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.close') }}</Button>
      <Button type="submit" form="enroll-form" size="sm" :disabled="pending || !name.trim()">
        <RefreshCw v-if="pending" class="animate-spin" aria-hidden="true" />
        <Plus v-else aria-hidden="true" />
        {{ $t('fleet.nodes.enroll.submit') }}
      </Button>
    </template>
  </ObjectSheet>

  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.nodes.enroll.discard.title')"
    :description="$t('fleet.nodes.enroll.discard.description')"
    :confirm-label="$t('fleet.nodes.enroll.discard.confirm')"
    :cancel-label="$t('fleet.nodes.enroll.discard.keep')"
    @confirm="discard"
  />
</template>
