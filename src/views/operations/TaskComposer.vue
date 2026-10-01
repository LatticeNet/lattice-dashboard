<script setup lang="ts">
/**
 * The New task layer of Tasks (design 23, section 4.3): pick targets, write
 * the script, queue it. It used to take the first screen of the page, above
 * every run; it is a layer of its own now, and Runs opens by default.
 *
 * The page keeps this mounted while the operator reads Runs, so a draft
 * survives a look at the list. A queued task is handed to the page, which
 * opens it in the run sheet.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Ban, CheckCircle2, ClipboardList, Lock, Play, RefreshCw, Search, TriangleAlert } from "lucide-vue-next";

import { api, ApiError, type CapabilityImpact, type Node, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { describeNodeStatus, isReporting } from "@/lib/nodeStatus";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import { agentConfigBadges, evalFilterExpression, nodeMatchesTargetToken } from "@/lib/nodeFilterExpressions";

import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const props = defineProps<{
  nodes: Node[];
  nodesLoading: boolean;
  nodesError: Error | null | undefined;
  nodesLoaded: boolean;
  /** The operator holds task:run. */
  canRun: boolean;
  /** The server has task execution switched off. */
  executionDisabled: boolean;
}>();

const emit = defineEmits<{ queued: [task: TaskView]; retryNodes: [] }>();

/**
 * A starting point for a probe script, offered rather than imposed.
 *
 * The obvious systemic fix for the failure this console kept producing - a
 * survey that measured nothing and reported exit 0 - is to inject `set -eu`
 * into every script. It does not work: `echo "k=$(cmd)"` succeeds whatever cmd
 * does, because errexit only fires when the substitution's status becomes the
 * command's, and every line of a probe script has that shape. It would break
 * the semantics of scripts already written and tested while catching nothing.
 *
 * So the pattern is offered as text the operator can read, edit, or delete:
 * resolve the binary rather than assume its path, capture once rather than
 * re-run per field, say what could not be measured, and exit non-zero when
 * nothing was, so the task's own failed count means something.
 */
const SURVEY_TEMPLATE = `# Probe template. Edit freely - this is a starting point, not a contract.
probe=ok
note=

# Resolve rather than assume: the same tool sits in different places across
# distributions, and a hardcoded path fails into an empty field.
BIN=
for c in /usr/sbin/sshd /usr/bin/sshd; do [ -x "$c" ] && BIN="$c" && break; done
[ -z "$BIN" ] && probe=missing-binary && note="sshd not found"

# Capture ONCE. Re-running a probe per field costs a re-parse each time and
# lets the fields describe different moments.
OUT=
if [ -n "$BIN" ]; then
  if OUT=$("$BIN" -T 2>&1) && [ -n "$OUT" ]; then :; else
    probe=probe-failed
    note=$(printf '%s' "$OUT" | head -1)
    OUT=
  fi
fi
# Most privileged probes read nothing as a non-root user and say so only on
# stderr, which a $(... 2>/dev/null) swallows.
[ "$(id -u)" != 0 ] && note="\${note:+$note; }not root (uid $(id -u))"

field() { [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed -n "s/^$1 //p" | sort -u | tr '\n' ','; }

echo "host=$(hostname)"
echo "probe=$probe"
echo "note=$note"
echo "uid=$(id -u)"
echo "port=$(field port)"

# Make an unmeasured run count as one. Without this the task reports exit 0 and
# reads exactly like a run that measured everything.
[ "$probe" = ok ] || exit 3
`;

const { t } = useI18n();

/**
 * A capability refusal names every refused node joined with "; ". One flat
 * toast line hides all but the first from a glance, so it becomes a titled
 * list: the admission gate saying no is information, not noise.
 */
function toastDispatchError(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.code === "capability_denied") {
    const refusals = error.message.split("; ").filter(Boolean);
    toast.error(t("operations.tasks.capabilityRefused", { count: refusals.length }), {
      description: refusals.join("\n"),
      duration: 10000,
      descriptionClass: "whitespace-pre-line",
    });
    return;
  }
  toast.error(error instanceof Error ? error.message : fallback);
}

/** Capabilities an operator may confine a task to. Only the enforced ones are
 *  offered: declaring an unenforced one would narrow nothing and read as a
 *  guarantee it cannot keep. */
const declarableQuery = useAsyncData<CapabilityImpact[] | undefined>(
  (signal) => api.capabilities.list({ signal }).then((r) => (r.capabilities ?? []).filter((c) => c.enforced)),
  { pollInterval: 60000 },
);
const declarableCapabilities = computed(() => declarableQuery.data.value ?? []);

const targetSearch = ref("");
const targetTag = ref("all");
const targetRegion = ref("all");
const targetExpr = ref("");
const selectedTargets = ref<string[]>([]);
const interpreter = ref("sh");
/**
 * An optional capability to confine this task to.
 *
 * It only ever narrows the target set. Nothing can verify that a script "is" a
 * sing-box script, so declaring one is a promise about your own intent - safe
 * to honour as a restriction, worthless as a grant. What it buys is that a
 * fleet-wide probe aimed at sing-box nodes cannot quietly also hit the machines
 * that do not run it.
 */
const capability = ref("");
const script = ref("");
const timeoutSec = ref(60);
const outputLimit = ref(16384);
const creating = ref(false);

const nodesById = computed<Record<string, Node>>(() => Object.fromEntries(props.nodes.map((n) => [n.id, n])));
const taskExecutionDisabled = computed(() => props.executionDisabled);

function nodeRegion(node: Node): string {
  return [node.geo?.country, node.geo?.region].filter(Boolean).join(" / ") || t("operations.tasks.unknownRegion");
}

const allTags = computed(() => {
  const set = new Set<string>();
  for (const node of props.nodes) for (const tag of node.tags ?? []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

const allRegions = computed(() => {
  const set = new Set<string>();
  for (const node of props.nodes) set.add(nodeRegion(node));
  return [...set].sort((a, b) => a.localeCompare(b));
});

const filteredTargetNodes = computed(() => {
  const q = targetSearch.value.trim().toLowerCase();
  return props.nodes
    .filter((node) => {
      if (targetTag.value !== "all" && !(node.tags ?? []).includes(targetTag.value)) return false;
      if (targetRegion.value !== "all" && nodeRegion(node) !== targetRegion.value) return false;
      if (targetExpr.value.trim() && !evalFilterExpression(targetExpr.value, (token) => nodeMatchesTargetToken(node, token)).value) return false;
      if (!q) return true;
      return [node.id, node.name, node.role, node.geo?.country, node.geo?.region, node.geo?.city, ...(node.tags ?? [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
});

const selectedSet = computed(() => new Set(selectedTargets.value));

function toggleTarget(id: string) {
  const next = new Set(selectedTargets.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTargets.value = [...next];
}

function selectVisible(onlineOnly = false) {
  const next = new Set(selectedTargets.value);
  for (const node of filteredTargetNodes.value) {
    if (!onlineOnly || node.online) next.add(node.id);
  }
  selectedTargets.value = [...next];
}

function clearVisible() {
  const visible = new Set(filteredTargetNodes.value.map((node) => node.id));
  selectedTargets.value = selectedTargets.value.filter((id) => !visible.has(id));
}

function nodeAgentBadges(node?: Node): string[] {
  return node ? agentConfigBadges(node) : [];
}

/**
 * What is already true about the selected targets, before anything is queued.
 *
 * The picker states each node's condition on its own row - on/off, exec, root -
 * and that is enough when you are choosing three. It stops working at fleet
 * size: selecting 33 nodes means scrolling a list, and nobody tallies while
 * scrolling. The run this was built for went out to 33 targets, one of which
 * refused exec and one of which had been offline for a day, and neither was
 * noticed until the results came back.
 *
 * So this counts rather than re-states, and it advises rather than blocks.
 * Queueing for a node you know is coming back is legitimate - the queue is
 * store-and-forward by design - and a refusal here would only teach people to
 * route around it.
 */
interface TargetPreflight {
  offline: string[];
  execDisabled: string[];
  unprivileged: string[];
}

const targetPreflight = computed<TargetPreflight>(() => {
  const out: TargetPreflight = { offline: [], execDisabled: [], unprivileged: [] };
  for (const id of selectedTargets.value) {
    const node = nodesById.value[id];
    if (!node) continue;
    const name = node.name || id;
    // "Will not run now" is the ontology's reporting question, not the legacy
    // online boolean: a never-reported node belongs in this list too.
    if (!isReporting(node)) out.offline.push(name);
    const runtime = node.agent_runtime;
    if (!runtime?.reported_at) continue;
    if (runtime.no_exec || runtime.allow_exec === false) out.execDisabled.push(name);
    else if (runtime.task_sandbox_features?.includes("non-root-agent")) out.unprivileged.push(name);
  }
  return out;
});

/**
 * Name the first few and count the rest.
 *
 * The messages are written label-first and carry no count of their own, so they
 * read correctly for one node and for forty without needing plural forms. This
 * codebase has no pluralization convention and Chinese has no plural, so
 * introducing `|` message forms here would add one for no reader benefit.
 */
const PREFLIGHT_NAMES_SHOWN = 3;

function preflightNames(names: string[]): string {
  if (names.length <= PREFLIGHT_NAMES_SHOWN) return names.join(", ");
  const shown = names.slice(0, PREFLIGHT_NAMES_SHOWN).join(", ");
  return t("operations.tasks.preflight.andMore", {
    names: shown,
    count: names.length - PREFLIGHT_NAMES_SHOWN,
  });
}

const preflightNotes = computed(() => {
  const p = targetPreflight.value;
  const notes: { key: string; text: string; tone: "warning" | "muted" }[] = [];
  // Ordered by how badly each one wastes the operator's time: a refusal is a
  // guaranteed failed row, an offline node is an indefinite wait, and an
  // unprivileged agent is a result that looks fine and is not.
  if (p.execDisabled.length)
    notes.push({
      key: "exec",
      tone: "warning",
      text: t("operations.tasks.preflight.execDisabled", { names: preflightNames(p.execDisabled) }),
    });
  if (p.offline.length)
    notes.push({
      key: "offline",
      tone: "warning",
      text: t("operations.tasks.preflight.offline", { names: preflightNames(p.offline) }),
    });
  if (p.unprivileged.length)
    notes.push({
      key: "unpriv",
      tone: "muted",
      text: t("operations.tasks.preflight.unprivileged", { names: preflightNames(p.unprivileged) }),
    });
  return notes;
});

async function createTask() {
  if (taskExecutionDisabled.value) {
    toast.error(t("operations.tasks.taskExecutionDisabled"));
    return;
  }
  if (!selectedTargets.value.length) {
    toast.error(t("operations.tasks.errNoTargets"));
    return;
  }
  if (!script.value.trim()) {
    toast.error(t("operations.tasks.errNoScript"));
    return;
  }
  creating.value = true;
  try {
    const task = await api.tasks.create({
      targets: selectedTargets.value,
      capability: capability.value || undefined,
      interpreter: interpreter.value,
      script: script.value,
      timeout_sec: timeoutSec.value,
      output_limit: outputLimit.value,
    });
    toast.success(t("operations.tasks.toastQueued"));
    script.value = "";
    emit("queued", task);
  } catch (error) {
    toastDispatchError(error, t("operations.tasks.toastFailed"));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="task-composer">
    <div class="space-y-1">
      <h2 class="flex items-center gap-2 text-base font-semibold">
        <Lock v-if="!canRun" class="size-4 text-muted-foreground" aria-hidden="true" />
        {{ $t('operations.tasks.queueTask') }}
      </h2>
      <p class="text-sm text-muted-foreground">
        {{ !canRun
          ? $t('operations.tasks.requiresRunScope')
          : taskExecutionDisabled
            ? $t('operations.tasks.taskExecutionDisabledHint')
            : $t('operations.tasks.queueTaskHint') }}
      </p>
    </div>
    <template v-if="canRun">
      <div v-if="taskExecutionDisabled" class="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-text">
        <Ban class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>{{ $t('operations.tasks.taskExecutionDisabled') }}</p>
      </div>
      <form class="grid grid-cols-1 min-w-0 gap-5 xl:grid-cols-[minmax(360px,0.9fr)_1fr]" @submit.prevent="createTask">
        <div class="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Label>{{ $t('operations.tasks.targets') }}</Label>
              <p class="text-xs text-muted-foreground">
                {{ $t('operations.tasks.selectedTargets', { count: selectedTargets.length }) }}
              </p>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <Button type="button" variant="outline" size="sm" @click="selectVisible(false)">
                {{ $t('operations.tasks.selectVisible') }}
              </Button>
              <Button type="button" variant="outline" size="sm" @click="selectVisible(true)">
                {{ $t('operations.tasks.selectOnline') }}
              </Button>
              <Button type="button" variant="ghost" size="sm" @click="clearVisible">
                {{ $t('operations.tasks.clearVisible') }}
              </Button>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_0.8fr_0.8fr]">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input v-model="targetSearch" class="pl-8" :placeholder="$t('operations.tasks.targetSearch')" />
            </div>
            <Select v-model="targetTag">
              <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterTag')" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('operations.tasks.allTags') }}</SelectItem>
                <SelectItem v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</SelectItem>
              </SelectContent>
            </Select>
            <Select v-model="targetRegion">
              <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterRegion')" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('operations.tasks.allRegions') }}</SelectItem>
                <SelectItem v-for="region in allRegions" :key="region" :value="region">{{ region }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="task-target-expr" class="text-xs text-muted-foreground">{{ $t('operations.tasks.targetExpression') }}</Label>
            <Input
              id="task-target-expr"
              v-model="targetExpr"
              class="font-mono text-xs"
              :placeholder="$t('operations.tasks.targetExpressionPlaceholder')"
            />
          </div>

          <DataState
            :loading="nodesLoading"
            :error="nodesError ?? undefined"
            :has-data="nodesLoaded"
            :is-empty="filteredTargetNodes.length === 0"
            :empty-title="$t('operations.tasks.noNodesTitle')"
            :empty-description="$t('operations.tasks.noNodesDescription')"
            @retry="emit('retryNodes')"
          >
            <div class="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
              <button
                v-for="node in filteredTargetNodes"
                :key="node.id"
                type="button"
                :class="cn(
                  'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-2.5 py-2 text-left transition-colors',
                  selectedSet.has(node.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                )"
                @click="toggleTarget(node.id)"
              >
                <div class="grid min-w-0 gap-1">
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span class="truncate text-sm font-medium" :title="node.name || node.id">{{ node.name || node.id }}</span>
                    <Badge :variant="statusMeta(describeNodeStatus(node).health).badgeVariant">
                      {{ $t(describeNodeStatus(node).labelKey) }}
                    </Badge>
                    <Badge
                      v-for="badge in nodeAgentBadges(node).slice(0, 3)"
                      :key="`${node.id}:${badge}`"
                      variant="outline"
                      class="text-[10px]"
                    >
                      {{ badge }}
                    </Badge>
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span class="truncate font-mono" :title="node.id">{{ node.id }}</span>
                    <span aria-hidden="true">·</span>
                    <span class="truncate" :title="nodeRegion(node)">{{ nodeRegion(node) }}</span>
                  </div>
                  <div class="flex max-h-6 flex-wrap gap-1 overflow-hidden">
                    <Badge variant="outline" class="text-[10px]">{{ nodeRegion(node) }}</Badge>
                    <Badge v-for="tag in (node.tags ?? []).slice(0, 5)" :key="tag" variant="secondary" class="text-[10px]">{{ tag }}</Badge>
                    <Badge v-if="(node.tags ?? []).length > 5" variant="outline" class="text-[10px]">+{{ (node.tags ?? []).length - 5 }}</Badge>
                  </div>
                </div>
                <span
                  :class="cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                    selectedSet.has(node.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )"
                >
                  <CheckCircle2 v-if="selectedSet.has(node.id)" class="size-3.5" aria-hidden="true" />
                </span>
              </button>
            </div>
          </DataState>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="grid gap-2">
              <Label>{{ $t('operations.tasks.interpreter') }}</Label>
              <Select v-model="interpreter">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sh">sh</SelectItem>
                  <SelectItem value="bash">bash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('operations.tasks.timeoutSec') }}</Label>
              <Input v-model.number="timeoutSec" type="number" min="1" max="600" />
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('operations.tasks.outputLimit') }}</Label>
              <Input v-model.number="outputLimit" type="number" min="256" max="65536" />
            </div>
          </div>
          <!-- Optional, and only offered when there is something to confine to.
               Narrows the targets; never widens them. -->
          <div v-if="declarableCapabilities.length" class="grid gap-1.5">
            <Label for="task-capability">{{ $t('operations.tasks.capability') }}</Label>
            <Select v-model="capability">
              <SelectTrigger id="task-capability">
                <SelectValue :placeholder="$t('operations.tasks.capabilityNone')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{{ $t('operations.tasks.capabilityNone') }}</SelectItem>
                <SelectItem
                  v-for="c in declarableCapabilities"
                  :key="c.capability"
                  :value="c.capability"
                >
                  {{ c.capability }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              {{ capability
                ? $t('operations.tasks.capabilityHintOn', { capability })
                : $t('operations.tasks.capabilityHint') }}
            </p>
          </div>

          <div class="grid gap-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <Label>{{ $t('operations.tasks.script') }}</Label>
              <!-- The good shape as a starting point, not as enforcement.
                   See SURVEY_TEMPLATE for why this is a template rather than
                   an injected preamble. -->
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                :disabled="!!script.trim()"
                :title="$t('operations.tasks.surveyTemplateHint')"
                @click="script = SURVEY_TEMPLATE"
              >
                <ClipboardList class="size-3.5" aria-hidden="true" />
                {{ $t('operations.tasks.surveyTemplate') }}
              </Button>
            </div>
            <textarea
              v-model="script"
              rows="12"
              class="rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder="uname -a"
            />
          </div>
          <!-- What is already known about the selection. Advisory, never a
               block: see targetPreflight. -->
          <ul v-if="preflightNotes.length" class="grid gap-1">
            <li
              v-for="note in preflightNotes"
              :key="note.key"
              :class="cn(
                'flex items-start gap-1.5 text-xs',
                note.tone === 'warning' ? 'text-warning-text' : 'text-muted-foreground',
              )"
            >
              <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ note.text }}</span>
            </li>
          </ul>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs text-muted-foreground">
              {{ $t('operations.tasks.fanoutHint') }}
            </p>
            <Button type="submit" :disabled="creating || taskExecutionDisabled || !selectedTargets.length || !script.trim()">
              <RefreshCw v-if="creating" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.queueTaskCta') }}
            </Button>
          </div>
        </div>
      </form>
    </template>
  </section>
</template>
