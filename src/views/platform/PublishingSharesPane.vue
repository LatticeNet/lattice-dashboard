<script setup lang="ts">
/**
 * The share lens of Publishing's Routes layer: the subscription URLs this
 * server serves, and everything that manages them. A row opens the share in
 * the page's sheet on `?open=<share id>` (design 23, section 4.5: Shares
 * stops being a page inside the page).
 *
 * The page mounts this pane on every layer and shows its table only on the
 * share lens (`showTable`). Its sheet and its create form therefore open over
 * whatever the operator is looking at: a plugin route in the all-origins
 * table, an attention item on Overview, or the page's Publish menu open the
 * share or the form here (`openShare`, `openPublish`) without moving the
 * operator to the share lens or rewriting `?origin=`. Off the share lens the
 * sheet opens only for an id that is one of the shares, because `?open=`
 * also names the page's own route sheet.
 *
 * The share list, the routes and the proxy users are the page's reads,
 * passed in, so one list decides which sheet an `?open=` belongs to and
 * nothing is polled twice; after a change the pane asks the page to read
 * them again (`reload`). The pane reads only what is its own: the plugin
 * list, when its table, sheet or form shows and the caller may read it
 * (audit:read), and the proxy users and the plugin's records for the form.
 *
 * This used to be a Networking page of its own. It lives here because a share
 * is a Publishing record, one whose bytes are rendered on request rather than
 * read from a bucket, and because it is core-owned: the route, the token
 * comparison, the rate limit and the audit trail belong to the server, and a
 * plugin frame runs with `connect-src 'none'` and can only reach methods its
 * signed manifest declares. Giving it the share API would hand token
 * management to plugin code (DESIGN-PROGRAM-2026-09 §9, Decision A).
 *
 * The token is a credential for whatever the share publishes, so no share
 * view carries it (operator rule, 2026-10-02: a credential reaches a person
 * only in an interactive session after step-up). The table and the sheet show
 * the path with the token left out; Reveal in the sheet asks for a second
 * factor and the server's reveal door answers the URL, which is audited. The
 * revealed URL lives in this pane only, for five minutes, and is dropped when
 * the sheet moves to another share, closes, or the share is rotated.
 *
 * Plugin absent: a share whose renderer plugin is not installed says so on its
 * row and in its detail, and refresh is disabled with that reason. Creating a
 * new plugin-backed share is unavailable with the reason. Proxy-user shares
 * are server-native and unaffected.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "@/lib/toast";
import {
  CalendarClock,
  EyeOff,
  Eye,
  Gauge,
  KeyRound,
  Link2,
  MonitorSmartphone,
  Plus,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-vue-next";

import { api, ApiError } from "@/lib/api";
import type {
  PluginView,
  ProxyUserView,
  PublishingRecord,
  ShareSource,
  SubscriptionShareCreateRequest,
  SubscriptionShareView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { useAuthStore } from "@/stores/auth";
import { useStepUp } from "@/composables/useStepUp";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  publishablePlugins as pickPublishablePlugins,
  recordsForShare,
  routeLabel,
  routeState,
  shareRefreshable,
  shareRendererState,
  canonicalPublishingQuery,
  pickShareRecord,
  shareDeepLink,
  type RouteState,
  type ShareRendererState,
} from "@/views/platform/publishingModel";
import { SHARE_SLUG_RE, suggestShareSlug } from "@/views/platform/subscriptionSharesModel";
import {
  emptyExpiryForm,
  expiryCreateValue,
  expiryFormError,
  expiryFormFor,
  expiryUpdateBody,
  type ExpiryForm,
} from "@/views/platform/shareExpiryModel";
import {
  DEFAULT_UPDATE_INTERVAL_HOURS,
  MAX_UPDATE_INTERVAL_HOURS,
  SHARE_TARGETS,
  clientUrl,
  fleetRefusalKind,
  intervalFieldError,
  intervalFieldFor,
  intervalFieldValue,
  isServing,
  maskedSharePath,
  maskedUrl,
  publishedState,
  renderBudgetTone,
  revealedUrl,
  shareFleetWarning,
  sourceLabel,
  type PublishedState,
} from "@/views/platform/publishedModel";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu from "@/components/common/RowMenu.vue";
import StepUpDialog from "@/components/common/StepUpDialog.vue";
import ShareExpiryFields from "@/components/networking/ShareExpiryFields.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const props = withDefaults(
  defineProps<{
    /** The share lens is showing: render the table. */
    showTable?: boolean;
    /** The page's share list: undefined until a read lands, kept across a failed refresh. */
    shares?: SubscriptionShareView[];
    sharesError?: Error | null;
    sharesLoading?: boolean;
    /** The page's publishing records, for where a share is reachable. */
    routes?: PublishingRecord[];
    /** The page's proxy users, or undefined when they were not read: whether a share resolves. */
    proxyUsers?: ProxyUserView[];
    /** Reads the page's shares and routes again, after a change here. */
    reload?: () => Promise<unknown>;
  }>(),
  {
    showTable: true,
    shares: undefined,
    sharesError: null,
    sharesLoading: false,
    routes: undefined,
    proxyUsers: undefined,
    reload: () => Promise.resolve(),
  },
);

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const canAdmin = computed(() => auth.can("proxy:admin"));

// The open share is the page's `?open=`, so a share is a link, a reload lands
// on it, and Escape returns focus to its row. The old `?share=` spelling is
// rewritten to this by the page.
const sheet = useRouteOpen();
const selectedId = computed(() => sheet.openId.value ?? "");
const publishOpen = ref(false);

const shares = computed(() => props.shares ?? []);

/** On the share lens every `?open=` is a share; elsewhere only an id the page's share list holds. */
const shareSheetOpen = computed(
  () => !!selectedId.value && (props.showTable || shares.value.some((share) => share.id === selectedId.value)),
);

/** The pane shows something: its table, a share's sheet or the create form. Its own reads wait for this. */
const active = computed(() => props.showTable || shareSheetOpen.value || publishOpen.value);

/**
 * The plugin list answers two questions on this pane: which plugins a new share
 * may be created against, and whether the plugin behind an existing share is
 * still there to render it. One read, both answers, so they cannot disagree.
 * /api/plugins needs audit:read; without it the list is never asked for, a
 * share's renderer stays unknown, and the form says why a plugin share cannot
 * be chosen. Read once when the pane first shows something, again on Refresh.
 */
const canReadPlugins = computed(() => auth.can("audit:read"));
const pluginsQuery = useAsyncData<PluginView[] | undefined>(
  (signal) => (canReadPlugins.value ? api.plugins.list({ signal }) : Promise.resolve(undefined)),
  { immediate: false },
);
const plugins = computed(() => (pluginsQuery.error.value ? undefined : pluginsQuery.data.value));
let pluginsRead: Promise<void> | null = null;
/** The first plugin read, shared by whoever needs it first; nothing without audit:read. */
function ensurePlugins(): Promise<void> {
  if (!canReadPlugins.value) return Promise.resolve();
  pluginsRead ??= pluginsQuery.refresh();
  return pluginsRead;
}
watch(
  active,
  (on) => {
    if (on) void ensurePlugins();
  },
  { immediate: true },
);
const publishablePlugins = computed(() => pickPublishablePlugins(plugins.value));
const pluginShareAvailable = computed(() => publishablePlugins.value.length > 0);

function rendererState(share: SubscriptionShareView): ShareRendererState {
  return shareRendererState(share, plugins.value);
}

function rendererPluginId(share: SubscriptionShareView): string {
  return share.source.kind === "plugin" ? share.source.plugin_id : "";
}

/**
 * The proxy users the server has, for the same two questions about the other
 * source kind: which users a new share may point at, and whether the user
 * behind an existing share is still there. The share API accepts any
 * non-empty id and serves a dangling share as an empty 404, so this list is
 * the only place the console can tell. Whether a share resolves comes from
 * the page's read, the one the routes table uses; the form reads its own copy
 * each time it opens, so a user created since is offered. Both are read only
 * by a caller who may (the endpoint wants proxy:read, which proxy:admin does
 * not imply), and a list that was not read or failed stays unknown: the form
 * falls back to a free-text id and no share is called unresolved on a guess.
 */
const canReadProxyUsers = computed(() => auth.can("proxy:read"));
const proxyUsersQuery = useAsyncData<ProxyUserView[] | undefined>(
  async (signal) => (await api.proxy.users({ signal })).users,
  { immediate: false },
);
const proxyUsers = computed(() => (proxyUsersQuery.error.value ? undefined : proxyUsersQuery.data.value));
const knownProxyUsers = computed(() => (props.proxyUsers ? new Set(props.proxyUsers.map((user) => user.id)) : undefined));

async function loadProxyUsers(): Promise<void> {
  if (canReadProxyUsers.value) await proxyUsersQuery.refresh();
}

/** The state a row and its detail show: the share alone, checked against the users actually read. */
function shareState(share: SubscriptionShareView): PublishedState {
  return publishedState(share, Date.now(), knownProxyUsers.value);
}

function serving(share: SubscriptionShareView): boolean {
  return isServing(share, Date.now(), knownProxyUsers.value);
}

/** The sentence the disabled refresh button and the detail notice both carry. */
function rendererReason(share: SubscriptionShareView): string {
  switch (rendererState(share)) {
    case "native":
      return t("networking.shares.refreshPluginOnly");
    case "missing":
      return t("platform.publishing.renderer.missingHint", { plugin: rendererPluginId(share) });
    case "inactive":
      return t("platform.publishing.renderer.inactiveHint", { plugin: rendererPluginId(share) });
    default:
      return t("networking.shares.refreshHint");
  }
}

const busyId = ref("");

// ── selection lives in the URL ─────────────────────────────────────────────
const selected = computed(() => shares.value.find((share) => share.id === selectedId.value));

function select(id: string): void {
  if (id) sheet.open(id);
  else sheet.close();
}

/** Opens a share from outside the table (a route row, an attention item), keeping the opener for focus. */
function openShare(id: string, opener?: HTMLElement | null): void {
  if (id) sheet.open(id, opener);
}

const sheetState = computed(() => {
  if (!selectedId.value) return "ready" as const;
  if (selected.value) return props.sharesError ? ("stale" as const) : ("ready" as const);
  if (props.shares === undefined) return props.sharesError ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

/**
 * Where a share is reachable comes from the publishing records, so this pane
 * and the routes table above it cannot drift into two different answers about
 * the same URL. The share still owns its token, its default format and its
 * per-client links, because those belong to the origin rather than to the route.
 */
const selectedRoutes = computed(() => (selected.value ? recordsForShare(props.routes ?? [], selected.value.id) : []));
/** The selected share's routes carry its unresolved state, as the routes table does. */
function selectedRouteState(record: PublishingRecord): RouteState {
  const unresolved =
    selected.value && shareState(selected.value) === "unresolved" ? new Set([selected.value.id]) : undefined;
  return routeState(record, unresolved);
}

/** The origin the browser is on is the origin the share is served from, so the
 *  displayed URL is the real one rather than a guess at LATTICE_PUBLIC_URL.
 *  The server's own URL wins when its reveal answer carries one. */
const origin = computed(() => (typeof window === "undefined" ? "" : window.location.origin));

// ── reveal ────────────────────────────────────────────────────────────────
//
// The share views carry no token. Reveal runs this page's step-up (a grant
// lasts a minute, so a second reveal inside it asks for nothing) and asks the
// server's reveal door, which audits each answer. What comes back is held
// here for REVEAL_HOLD_MS and never written to the address, the page state or
// a log.

const REVEAL_HOLD_MS = 5 * 60_000;
const revealStepUp = useStepUp({
  required: t("networking.shares.reveal.required"),
  failed: t("networking.shares.reveal.failed"),
  passkeyFailed: t("networking.shares.reveal.passkeyFailed"),
});
const revealed = ref<{ shareId: string; url: string } | null>(null);
/**
 * The share whose reveal is in flight, or "". Set once the grant is in hand,
 * so the Reveal button stays enabled while the prompt is open and focus can
 * return to it when the prompt closes.
 */
const revealing = ref("");
/** A reveal is waiting on the step-up prompt. */
let awaitingGrant = false;
/** The browser refused to copy the revealed URL: show it whole, to copy by hand. */
const handCopy = ref(false);
let revealTimer: ReturnType<typeof setTimeout> | undefined;

function dropReveal(): void {
  clearTimeout(revealTimer);
  revealTimer = undefined;
  revealed.value = null;
  handCopy.value = false;
}

/** The revealed URL of the share the sheet shows, or "". */
const selectedUrl = computed(() =>
  revealed.value && selected.value && revealed.value.shareId === selected.value.id ? revealed.value.url : "",
);

async function reveal(share: SubscriptionShareView): Promise<void> {
  if (revealing.value || awaitingGrant) return;
  let grant: string;
  awaitingGrant = true;
  try {
    grant = await revealStepUp.request();
  } catch {
    // The operator closed the prompt: nothing was revealed, and nothing needs saying.
    return;
  } finally {
    awaitingGrant = false;
  }
  revealing.value = share.id;
  try {
    const answer = await api.subscriptionShares.reveal(share.id, grant);
    // The sheet may have moved to another share while the operator typed.
    if (selectedId.value !== share.id) return;
    dropReveal();
    revealed.value = { shareId: share.id, url: revealedUrl(origin.value, answer) };
    revealTimer = setTimeout(dropReveal, REVEAL_HOLD_MS);
  } catch (error) {
    toast.error(describe(error, t("networking.shares.reveal.revealFailed")));
  } finally {
    revealing.value = "";
  }
}

// A revealed URL belongs to the share it was asked for, while the sheet shows it.
watch(selectedId, (id) => {
  if (revealed.value && revealed.value.shareId !== id) dropReveal();
});
onBeforeUnmount(dropReveal);

async function copyRevealed(text: string, message: string): Promise<void> {
  if (!(await copy(text, message))) handCopy.value = true;
}

// ── refresh interval and render budget ─────────────────────────────────────
//
// Clients that honor Profile-Update-Interval fetch again after the hours the
// link advertises. The field is empty for the default, so opening and saving
// it changes nothing; the draft follows the share only when the share's own
// value changes, so a 30 s re-read does not wipe what the operator is typing.

const intervalDraft = ref("");
const intervalSaving = ref(false);
watch(
  () => [selected.value?.id, selected.value?.update_interval_hours] as const,
  () => {
    intervalDraft.value = selected.value ? intervalFieldFor(selected.value) : "";
  },
  { immediate: true },
);
const intervalError = computed(() => intervalFieldError(intervalDraft.value));
const intervalDirty = computed(() => {
  const share = selected.value;
  if (!share || intervalError.value) return false;
  const draft = intervalFieldValue(intervalDraft.value) || DEFAULT_UPDATE_INTERVAL_HOURS;
  return draft !== (share.update_interval_hours || DEFAULT_UPDATE_INTERVAL_HOURS);
});

async function saveInterval(): Promise<void> {
  const share = selected.value;
  if (!share || !intervalDirty.value || intervalSaving.value) return;
  intervalSaving.value = true;
  try {
    await api.subscriptionShares.update(share.id, { update_interval_hours: intervalFieldValue(intervalDraft.value) });
    toast.success(t("networking.shares.interval.saved", { slug: share.slug }));
    await props.reload();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.interval.saveFailed")));
  } finally {
    intervalSaving.value = false;
  }
}

function intervalHours(share: SubscriptionShareView): number {
  return share.update_interval_hours || DEFAULT_UPDATE_INTERVAL_HOURS;
}

/** How many renders were refused since the server started, and when the last one was. */
function budgetRefusedLine(share: SubscriptionShareView): string {
  const budget = share.render_budget;
  if (!budget) return "";
  const refused = t("networking.shares.budget.refused", { n: budget.refused }, budget.refused);
  return budget.last_refused_at
    ? t("networking.shares.budget.refusedLast", { refused, when: formatRelativeTime(budget.last_refused_at) })
    : refused;
}

/** The share's render budget is spent: new renders answer the decoy until it refills. */
function budgetExhausted(share: SubscriptionShareView): boolean {
  return renderBudgetTone(share.render_budget) === "exhausted";
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

const stateVariant: Record<PublishedState, "default" | "secondary" | "destructive" | "outline"> = {
  live: "secondary",
  expiring: "outline",
  expired: "destructive",
  paused: "outline",
  unresolved: "destructive",
};

/** The page's Refresh: the page re-reads the shares and routes; the pane re-reads what it has read itself. */
async function refresh(): Promise<void> {
  await Promise.all([
    pluginsRead ? (pluginsRead = pluginsQuery.refresh()) : Promise.resolve(),
    proxyUsersQuery.data.value !== undefined ? loadProxyUsers() : Promise.resolve(),
  ]);
}

// The page-level Refresh button reloads this pane too, so one control means
// one thing for the whole page; the page's Publish menu opens the form.
defineExpose({ refresh, openPublish: () => void openPublish(), openShare });

// ── publish ────────────────────────────────────────────────────────────────
//
// The dialog reads the plugin's own records rather than asking for ids as free
// text, so publishing is a choice rather than a transcription.

const publishing = ref(false);
const draft = ref<{
  kind: ShareSource["kind"];
  pluginId: string;
  subscriptionId: string;
  proxyUserId: string;
  slug: string;
  defaultFormat: string;
  expiry: ExpiryForm;
  interval: string;
  /** Sent only after the server refused the record as a fleet feed and the operator ticked the box. */
  fleetCredentials: boolean;
}>({
  kind: "plugin",
  pluginId: "",
  subscriptionId: "",
  proxyUserId: "",
  slug: "",
  defaultFormat: "",
  expiry: emptyExpiryForm(),
  interval: "",
  fleetCredentials: false,
});

/**
 * The server's refusal of a record that reads vpn-core's identity-less
 * export (400 fleet_feed_flag_required): such a share hands every identity's
 * credentials to whoever holds the URL. The console cannot tell which records
 * do that, so the form learns it from the refusal, names the record in its
 * own words (the server's sentence, which ends in API field names, stays in
 * the callout's title), and sends the flag only once the operator ticks the
 * box. Picking another record or source clears it.
 */
const fleetFeedRefusal = ref("");
/**
 * Which case refused it, from the verdict the server sends beside the error:
 * the record reads the fleet export ("fleet"), or the server could not read
 * Sub-Store's record list to check ("unchecked"). The two need different
 * words; the box and the flag are the same.
 */
const fleetFeedRefusalKind = ref<"fleet" | "unchecked">("fleet");
watch(
  () => [draft.value.kind, draft.value.pluginId, draft.value.subscriptionId, draft.value.proxyUserId] as const,
  () => {
    fleetFeedRefusal.value = "";
    draft.value.fleetCredentials = false;
  },
);
const draftIntervalError = computed(() => intervalFieldError(draft.value.interval));
/** The record or proxy user the form is about to publish, by the name the picker shows. */
const draftRecordName = computed(() => {
  if (draft.value.kind !== "plugin") return draft.value.proxyUserId.trim();
  const record = records.value.find((entry) => entry.id === draft.value.subscriptionId);
  return record?.display_name || record?.name || draft.value.subscriptionId;
});

// The clock the expiry forms validate against, sampled when a dialog opens. A
// live ticking `now` would let "the last day" flip to invalid mid-edit while the
// operator is still typing. The server checks the instant again on arrival.
const now = ref(Date.now());

interface PluginRecord {
  id: string;
  name?: string;
  display_name?: string;
  kind?: string;
}

const records = ref<PluginRecord[]>([]);
const recordsLoading = ref(false);
const recordsError = ref("");

/** Read the chosen plugin's records through the gateway. A plugin that does not
 *  answer is reported as such rather than leaving an empty picker that looks
 *  like a plugin with nothing in it. */
async function loadRecords(): Promise<void> {
  const pluginId = draft.value.pluginId;
  records.value = [];
  recordsError.value = "";
  if (!pluginId) return;
  recordsLoading.value = true;
  try {
    const response = await api.plugins.call<{ subscriptions?: PluginRecord[] } | PluginRecord[]>(
      pluginId,
      `${pluginId}/subscription`,
      "list",
      {},
    );
    const list = Array.isArray(response) ? response : (response.subscriptions ?? []);
    records.value = list.filter((record) => !!record?.id);
  } catch (error) {
    recordsError.value = describe(error, t("networking.shares.recordsFailed"));
  } finally {
    recordsLoading.value = false;
  }
}

watch(() => draft.value.pluginId, loadRecords);

/*
 * A record the deep link named, chosen once the plugin's records have loaded.
 * Sub-Store links by record name, and an id can differ from its name
 * (imported records are "imported-<kind>-<name>"), so the name is matched
 * against the loaded list and never written as the id. A name that matches
 * nothing leaves the picker empty and says so.
 */
const wantedRecord = ref("");
const missingRecord = ref("");
watch([records, recordsLoading], () => {
  const name = wantedRecord.value;
  if (!name || recordsLoading.value) return;
  wantedRecord.value = "";
  const match = pickShareRecord(records.value, name);
  if (match) draft.value.subscriptionId = match;
  else if (!recordsError.value) missingRecord.value = name;
});
watch(
  () => draft.value.subscriptionId,
  (id) => {
    if (!id || draft.value.slug.trim()) return;
    const record = records.value.find((entry) => entry.id === id);
    const name = record?.display_name || record?.name || id;
    draft.value.slug = suggestShareSlug(name, shares.value.map((share) => share.slug));
  },
);

const slugError = computed(() => {
  const slug = draft.value.slug.trim();
  if (!slug) return "";
  if (!SHARE_SLUG_RE.test(slug)) return t("networking.shares.slugRule");
  if (shares.value.some((share) => share.slug === slug)) return t("networking.shares.slugTaken");
  return "";
});

const canPublish = computed(() => {
  if (!draft.value.slug.trim() || slugError.value || publishing.value) return false;
  if (expiryFormError(draft.value.expiry, now.value)) return false;
  if (draftIntervalError.value) return false;
  if (fleetFeedRefusal.value && !draft.value.fleetCredentials) return false;
  if (draft.value.kind === "plugin") {
    const id = draft.value.subscriptionId;
    return pluginShareAvailable.value && !!draft.value.pluginId && records.value.some((record) => record.id === id);
  }
  return !!draft.value.proxyUserId.trim();
});

/**
 * Opens the form, optionally on a record a deep link names. The kind and the
 * plugin come from the plugin list, so it is read first: a form opened before
 * it landed would offer the proxy-user kind as if no plugin could serve.
 */
async function openPublish(wanted = ""): Promise<void> {
  await ensurePlugins();
  // Plugin absent: the form opens on the kind that can still be created, and
  // the plugin kind stays in the picker, disabled, with the reason beside it.
  draft.value = {
    kind: pluginShareAvailable.value ? "plugin" : "core.proxy_user",
    pluginId: publishablePlugins.value[0]?.id ?? "",
    subscriptionId: "",
    proxyUserId: "",
    slug: "",
    defaultFormat: "",
    expiry: emptyExpiryForm(),
    interval: "",
    fleetCredentials: false,
  };
  fleetFeedRefusal.value = "";
  // Matched by id or name once the plugin's records arrive; the slug follows the pick.
  wantedRecord.value = wanted && pluginShareAvailable.value ? wanted : "";
  missingRecord.value = "";
  now.value = Date.now();
  publishOpen.value = true;
  void loadRecords();
  // Re-read once per opening, so a user created since the pane loaded is offered.
  void loadProxyUsers();
}

async function publish(): Promise<void> {
  if (!canPublish.value) return;
  publishing.value = true;
  try {
    const source: ShareSource =
      draft.value.kind === "plugin"
        ? {
            kind: "plugin",
            plugin_id: draft.value.pluginId,
            subscription_id: draft.value.subscriptionId,
          }
        : { kind: "core.proxy_user", proxy_user_id: draft.value.proxyUserId.trim() };
    const interval = intervalFieldValue(draft.value.interval);
    const body: SubscriptionShareCreateRequest = {
      slug: draft.value.slug.trim(),
      source,
      default_format: draft.value.defaultFormat || undefined,
      expires_at: expiryCreateValue(draft.value.expiry, now.value),
      ...(interval ? { update_interval_hours: interval } : {}),
      ...(fleetFeedRefusal.value && draft.value.fleetCredentials ? { publishes_fleet_credentials: true } : {}),
    };
    const created = await api.subscriptionShares.create(body);
    toast.success(t("networking.shares.published", { slug: created.slug }));
    publishOpen.value = false;
    // The page's list holds the new share before its sheet opens over the current layer.
    await props.reload();
    select(created.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "fleet_feed_flag_required") {
      // Answered in the form, beside the box that lifts it, not in a toast that fades.
      fleetFeedRefusal.value = error.serverMessage || t("networking.shares.fleetFeed.refused");
      fleetFeedRefusalKind.value = fleetRefusalKind(error.body);
      draft.value.fleetCredentials = false;
    } else {
      toast.error(describe(error, t("networking.shares.publishFailed")));
    }
  } finally {
    publishing.value = false;
  }
}

// Changing the expiry of a share that already exists. Deliberately not part of
// rotate or delete: rotation mints a new URL and breaks every client holding the
// old one, while changing when a URL dies does not touch the URL at all.
const expiryOpen = ref(false);
const expirySaving = ref(false);
const expiryTarget = ref<SubscriptionShareView | null>(null);
const expiryDraft = ref<ExpiryForm>(emptyExpiryForm());

function openExpiry(share: SubscriptionShareView): void {
  expiryTarget.value = share;
  expiryDraft.value = expiryFormFor(share);
  now.value = Date.now();
  expiryOpen.value = true;
}

async function saveExpiry(): Promise<void> {
  const share = expiryTarget.value;
  if (!share || expiryFormError(expiryDraft.value, now.value)) return;
  expirySaving.value = true;
  try {
    await api.subscriptionShares.update(share.id, expiryUpdateBody(expiryDraft.value, now.value));
    toast.success(t("networking.shares.expiry.saved"));
    expiryOpen.value = false;
    await props.reload();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.expiry.saveFailed")));
  } finally {
    expirySaving.value = false;
  }
}

// ── per-share actions ──────────────────────────────────────────────────────

const rotateTarget = ref<SubscriptionShareView | null>(null);
const deleteTarget = ref<SubscriptionShareView | null>(null);
/** Rotating and deleting both break every client already using the URL, so the
 *  confirmation asks for the slug back rather than for a click. */
const confirmText = ref("");
const confirmMatches = computed(() => {
  const target = rotateTarget.value ?? deleteTarget.value;
  return !!target && confirmText.value.trim() === target.slug;
});

/** Set when Confirm is pressed with a slug that does not match, so the click
 *  answers instead of doing nothing. */
const confirmError = ref(false);
watch(confirmText, () => {
  if (confirmMatches.value) confirmError.value = false;
});

function askRotate(share: SubscriptionShareView): void {
  confirmText.value = "";
  confirmError.value = false;
  deleteTarget.value = null;
  rotateTarget.value = share;
}

function askDelete(share: SubscriptionShareView): void {
  confirmText.value = "";
  confirmError.value = false;
  rotateTarget.value = null;
  deleteTarget.value = share;
}

function confirmDestructive(): void {
  if (!confirmMatches.value) {
    confirmError.value = true;
    return;
  }
  if (rotateTarget.value) void rotate();
  else void remove();
}

async function rotate(): Promise<void> {
  const share = rotateTarget.value;
  if (!share || !confirmMatches.value) return;
  busyId.value = share.id;
  try {
    const rotated = await api.subscriptionShares.rotate(share.id);
    // The URL held from a reveal is the one that just stopped working.
    if (revealed.value?.shareId === share.id) dropReveal();
    toast.success(t("networking.shares.rotated", { slug: rotated.slug }));
    rotateTarget.value = null;
    await props.reload();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.rotateFailed")));
  } finally {
    busyId.value = "";
  }
}

async function remove(): Promise<void> {
  const share = deleteTarget.value;
  if (!share || !confirmMatches.value) return;
  busyId.value = share.id;
  try {
    await api.subscriptionShares.remove(share.id);
    toast.success(t("networking.shares.deleted", { slug: share.slug }));
    deleteTarget.value = null;
    if (selectedId.value === share.id) select("");
    await props.reload();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.deleteFailed")));
  } finally {
    busyId.value = "";
  }
}

async function refreshSource(share: SubscriptionShareView): Promise<void> {
  if (!shareRefreshable(rendererState(share))) return;
  busyId.value = share.id;
  try {
    // The endpoint answers 200 even when the provider failed and the previous
    // snapshot was kept, flagging it as `stale`. Reporting that as a successful
    // refresh is exactly the lie this console exists to avoid.
    const result = (await api.subscriptionShares.refresh(share.id)) as { stale?: boolean } | null;
    if (result?.stale) toast.warning(t("networking.shares.refreshStale", { slug: share.slug }));
    else toast.success(t("networking.shares.refreshed", { slug: share.slug }));
  } catch (error) {
    // A provider that cannot be reached is not a broken share: the last good
    // snapshot keeps being served. Say both halves.
    toast.error(`${describe(error, t("networking.shares.refreshFailed"))} ${t("networking.shares.lastGoodServed")}`);
  } finally {
    busyId.value = "";
  }
}

async function copy(text: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
    return true;
  } catch {
    toast.error(t("networking.shares.clipboardUnavailable"));
    return false;
  }
}

// ── table ──────────────────────────────────────────────────────────────────

const columns = computed<DataTableColumn<SubscriptionShareView>[]>(() => [
  { key: "slug", label: t("networking.shares.columns.slug"), sortable: true, searchable: true },
  {
    key: "state",
    label: t("networking.shares.columns.state"),
    sortable: true,
    filterable: true,
    class: "w-[7.5rem]",
    value: (row) => shareState(row),
  },
  {
    key: "source",
    label: t("networking.shares.columns.source"),
    sortable: true,
    searchable: true,
    filterAliases: ["plugin", "record"],
    value: (row) => sourceLabel(row),
  },
  {
    key: "format",
    label: t("networking.shares.columns.format"),
    sortable: true,
    class: "w-[8rem]",
    value: (row) => row.default_format || "",
  },
  {
    key: "rotated",
    label: t("networking.shares.columns.rotated"),
    sortable: true,
    align: "right",
    class: "w-[9rem]",
    value: (row) => row.rotated_at || row.created_at,
  },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

/** The share's state as text: live is quiet, a share that stops answering is loud. */
const STATE_TONE: Record<PublishedState, string> = {
  live: "text-muted-foreground",
  paused: "text-muted-foreground",
  expiring: "text-warning-text",
  expired: "text-destructive",
  unresolved: "text-destructive",
};

function menuFor(share: SubscriptionShareView) {
  return [
    { key: "refresh", label: t("networking.shares.refreshSource"), icon: RefreshCw, hidden: !canAdmin.value, disabled: busyId.value === share.id || !shareRefreshable(rendererState(share)), reason: shareRefreshable(rendererState(share)) ? undefined : rendererReason(share), run: () => void refreshSource(share) },
    { key: "expiry", label: t("networking.shares.expiry.change"), icon: CalendarClock, hidden: !canAdmin.value, run: () => openExpiry(share) },
    { key: "rotate", label: t("networking.shares.rotate"), icon: KeyRound, hidden: !canAdmin.value, run: () => askRotate(share) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => askDelete(share) },
  ];
}

// ── deep link from a plugin ────────────────────────────────────────────────

/**
 * The Sub-Store frame asks the host to navigate here with
 * ?create=1&for=<record>, today through the redirect from the retired path.
 * The dialog opens with that record already chosen, so the operator lands on a
 * decision instead of a blank form. The keys are consumed so a reload does not
 * reopen it, and the lens stays pinned so this pane stays mounted.
 */
// The pane mounts with the page, and the page rewrites an old link onto the
// Routes layer (canonicalPublishingQuery) as it mounts. Two replaces in
// flight race, and the page's could land last and put the create keys back,
// so the link waits for the page's rewrite, which the query watcher brings
// here. One opening runs at a time, and openPublish waits for the plugin list
// before it picks the kind.
let deepLinkOpening = false;

async function applyDeepLink(): Promise<void> {
  if (canonicalPublishingQuery(route.query)) return;
  const link = shareDeepLink(route.query);
  if (!link || deepLinkOpening) return;
  deepLinkOpening = true;
  try {
    void router.replace({ query: link.next });
    await openPublish(link.record);
  } finally {
    deepLinkOpening = false;
  }
}

onMounted(() => void applyDeepLink());
watch(() => route.query, () => void applyDeepLink());
</script>

<template>
  <section class="space-y-4">
    <DataTable
      v-if="showTable"
      state-key="shares"
      :columns="columns"
      :rows="shares"
      :row-key="(row) => row.id"
      :loading="props.sharesLoading"
      :error="props.sharesError"
      :has-data="props.shares !== undefined"
      :page-size="25"
      :searchable="shares.length > 0"
      :expression-filter="false"
      :search-placeholder="$t('networking.shares.searchPlaceholder')"
      :row-click="(row, el) => sheet.open(row.id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="$t('networking.shares.emptyTitle')"
      :empty-description="$t('networking.shares.emptyDescription')"
      @retry="props.reload"
    >
      <template #empty>
        <div class="space-y-3 rounded-xl border border-dashed border-border p-6 text-center">
          <p class="text-sm font-medium">{{ $t('networking.shares.emptyTitle') }}</p>
          <p class="mx-auto max-w-prose text-sm text-muted-foreground">{{ $t('networking.shares.emptyDescription') }}</p>
          <Button v-if="canAdmin" size="sm" variant="outline" @click="openPublish">
            <Plus class="size-4" aria-hidden="true" />
            {{ $t('networking.shares.publish') }}
          </Button>
        </div>
      </template>
      <template #cell-slug="{ row }">
        <div class="min-w-0">
          <p class="truncate font-medium" :title="`/${row.slug}`">/{{ row.slug }}</p>
          <p class="truncate font-mono text-xs text-muted-foreground">{{ maskedSharePath(row) }}</p>
        </div>
      </template>
      <template #cell-state="{ row }">
        <span :class="cn('whitespace-nowrap text-xs', STATE_TONE[shareState(row)])">
          {{ $t('networking.shares.state.' + shareState(row)) }}
        </span>
        <span v-if="row.expires_at && shareState(row) !== 'expired'" class="block text-xs text-muted-foreground" :title="formatDateTime(row.expires_at)">
          {{ formatRelativeTime(row.expires_at) }}
        </span>
        <!-- Serving, but new renders answer the decoy: said on the row, not only in the sheet. -->
        <span v-if="budgetExhausted(row)" class="mt-0.5 flex items-center gap-1 whitespace-nowrap text-xs text-destructive">
          <Gauge class="size-3 shrink-0" aria-hidden="true" />
          {{ $t('networking.shares.budget.exhaustedShort') }}
        </span>
      </template>
      <template #cell-source="{ row }">
        <div class="min-w-0">
          <span class="block truncate text-sm" :title="sourceLabel(row)">{{ sourceLabel(row) }}</span>
          <!-- Plugin absent, said on the row: the share exists, its renderer
               does not, and the two facts read together. -->
          <span
            v-if="rendererState(row) === 'missing' || rendererState(row) === 'inactive'"
            class="mt-0.5 flex items-center gap-1 text-xs text-warning-text"
            :title="rendererReason(row)"
          >
            <PlugZap class="size-3 shrink-0" aria-hidden="true" />
            {{ $t(`platform.publishing.renderer.${rendererState(row)}`) }}
          </span>
          <span v-if="shareFleetWarning(row)" class="mt-0.5 flex items-center gap-1 text-xs text-warning-text" data-testid="share-fleet-badge">
            <ShieldAlert class="size-3 shrink-0" aria-hidden="true" />
            {{ $t(shareFleetWarning(row) === 'unchecked' ? 'networking.shares.fleetFeed.uncheckedShort' : 'networking.shares.fleetFeed.short') }}
          </span>
        </div>
      </template>
      <template #cell-format="{ row }">
        <span class="text-sm text-muted-foreground">{{ row.default_format || $t('networking.shares.formatAuto') }}</span>
      </template>
      <template #cell-rotated="{ row }">
        <span class="text-sm tabular" :title="formatDateTime(row.rotated_at || row.created_at)">
          {{ formatRelativeTime(row.rotated_at || row.created_at) }}
        </span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu v-if="canAdmin" :name="`/${row.slug}`" :items="menuFor(row)" />
      </template>
    </DataTable>

    <!-- One share, its URL and the client-specific links, in the page's sheet. -->
    <ObjectSheet
      :open="shareSheetOpen"
      :title="selected ? `/${selected.slug}` : selectedId"
      :subtitle="selected ? sourceLabel(selected) : undefined"
      :mono-title="true"
      :mono-subtitle="false"
      :state="sheetState"
      :error="props.sharesError ? describe(props.sharesError, '') : null"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('platform.publishingPage.shareGoneTitle')"
      :gone-description="$t('platform.publishingPage.shareGoneDescription')"
      @close="sheet.close"
    >
      <div v-if="selected" class="space-y-4 text-sm">
        <p :class="STATE_TONE[shareState(selected)] === 'text-muted-foreground' ? 'text-foreground' : STATE_TONE[shareState(selected)]">
          {{ $t('networking.shares.state.' + shareState(selected)) }}
        </p>
        <!-- Spent render budget: real clients are getting the decoy right now. -->
        <div
          v-if="selected.render_budget && budgetExhausted(selected)"
          class="rounded-md border-l-2 border-destructive bg-muted/40 px-3 py-2 text-xs"
          data-testid="share-budget-exhausted"
        >
          <p class="font-medium">{{ $t('networking.shares.budget.exhaustedTitle') }}</p>
          <p class="mt-1 text-muted-foreground">
            {{ $t('networking.shares.budget.exhaustedDetail', { perHour: selected.render_budget.per_hour }) }}
          </p>
          <p class="mt-1 text-muted-foreground">{{ budgetRefusedLine(selected) }}</p>
        </div>

        <div
          v-if="shareFleetWarning(selected)"
          class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs"
          data-testid="share-fleet-feed"
          :data-fleet-warning="shareFleetWarning(selected)"
        >
          <p class="font-medium">
            {{ $t(shareFleetWarning(selected) === 'unchecked' ? 'networking.shares.fleetFeed.uncheckedTitle' : 'networking.shares.fleetFeed.title') }}
          </p>
          <p class="mt-1 text-muted-foreground">
            {{
              $t(
                shareFleetWarning(selected) === 'unchecked'
                  ? 'networking.shares.fleetFeed.uncheckedDetail'
                  : shareFleetWarning(selected) === 'detected'
                    ? 'networking.shares.fleetFeed.detectedDetail'
                    : 'networking.shares.fleetFeed.detail',
              )
            }}
          </p>
        </div>

        <div>
          <p class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.url') }}</p>
          <div v-if="selectedUrl" class="mt-1 flex items-start gap-2" data-testid="share-url-revealed">
            <code class="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">{{ maskedUrl(selectedUrl) }}</code>
            <Button variant="ghost" size="sm" @click="copyRevealed(selectedUrl, $t('networking.shares.reveal.copied'))">
              <Link2 class="size-4" aria-hidden="true" />
              {{ $t('networking.shares.reveal.copy') }}
            </Button>
            <Button variant="ghost" size="icon-sm" :aria-label="$t('networking.shares.reveal.hide')" :title="$t('networking.shares.reveal.hide')" @click="dropReveal">
              <EyeOff class="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div v-else class="mt-1 flex items-start gap-2">
            <code class="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground" data-testid="share-url-masked">{{ origin }}{{ maskedSharePath(selected) }}</code>
            <Button variant="outline" size="sm" :disabled="!!revealing" data-testid="share-reveal" @click="reveal(selected)">
              <RefreshCw v-if="revealing === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <Eye v-else class="size-4" aria-hidden="true" />
              {{ $t('networking.shares.reveal.action') }}
            </Button>
          </div>
          <!-- The browser refused the copy: the whole URL, selected, to copy by hand. -->
          <Input
            v-if="selectedUrl && handCopy"
            class="mt-2 font-mono text-xs"
            readonly
            :model-value="selectedUrl"
            :aria-label="$t('networking.shares.url')"
            data-testid="share-url-hand-copy"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <p class="mt-1.5 text-xs text-muted-foreground">
            {{ selectedUrl ? $t('networking.shares.reveal.heldNote') : $t('networking.shares.tokenNote') }}
          </p>
        </div>

        <!-- A dangling proxy user is one specific reason for a 404, and it
             gets its own sentence in place of the general one. -->
        <div v-if="shareState(selected) === 'unresolved'" class="rounded-md border-l-2 border-destructive bg-muted/40 px-3 py-2 text-xs">
          {{ $t('networking.shares.unresolvedHint') }}
        </div>
        <div v-else-if="!serving(selected)" class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs">
          {{ $t('networking.shares.notServing') }}
        </div>

        <div
          v-if="rendererState(selected) === 'missing' || rendererState(selected) === 'inactive'"
          class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs"
        >
          <p class="font-medium">{{ $t(`platform.publishing.renderer.${rendererState(selected)}`) }}</p>
          <p class="mt-1 text-muted-foreground">{{ rendererReason(selected) }}</p>
          <RouterLink
            to="/platform/plugins"
            class="mt-1 inline-block rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >{{ $t('platform.publishing.renderer.openPlugins') }}</RouterLink>
        </div>

        <div v-if="selectedRoutes.length">
          <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.publishing.shareRouteTitle') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ $t('platform.publishing.shareRouteDescription') }}</p>
          <div v-for="record in selectedRoutes" :key="record.id" class="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <code class="rounded bg-muted px-2 py-1 font-mono">{{ routeLabel(record, $t('platform.publishing.anyHost')) }}</code>
            <!-- The same rule the routes table applies, so this cannot say
                 serving under a callout saying the URL returns 404. -->
            <span :class="selectedRouteState(record) === 'unresolved' ? 'text-destructive' : 'text-muted-foreground'">
              {{ $t(`platform.publishing.state.${selectedRouteState(record)}`) }}
            </span>
            <span v-if="record.reserved" class="text-muted-foreground" :title="$t('platform.publishing.reservedHint')">· {{ $t('platform.publishing.reserved') }}</span>
          </div>
        </div>

        <div>
          <p class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.clientLinks') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ selectedUrl ? $t('networking.shares.clientLinksHint') : $t('networking.shares.reveal.clientLinksLocked') }}
          </p>
          <div class="mt-2 grid grid-cols-2 gap-1.5">
            <Button
              v-for="target in SHARE_TARGETS"
              :key="target.id"
              variant="outline"
              size="sm"
              class="justify-between"
              :disabled="!selectedUrl"
              @click="copyRevealed(clientUrl(selectedUrl, target.id), $t('networking.shares.copiedClient', { target: target.label }))"
            >
              <span class="truncate">{{ target.label }}</span>
              <MonitorSmartphone class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <form class="grid gap-1.5 border-t border-border pt-3" data-testid="share-interval" @submit.prevent="saveInterval">
          <Label for="share-interval" class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.interval.label') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="share-interval"
              v-model="intervalDraft"
              class="w-24"
              inputmode="numeric"
              autocomplete="off"
              :placeholder="$t('networking.shares.interval.placeholder')"
              :disabled="!canAdmin || intervalSaving"
              :aria-invalid="!!intervalError || undefined"
              aria-describedby="share-interval-hint"
            />
            <span class="text-xs text-muted-foreground">{{ $t('networking.shares.interval.unit') }}</span>
            <Button v-if="canAdmin" type="submit" size="sm" variant="outline" class="ml-auto" :disabled="!intervalDirty || intervalSaving">
              <RefreshCw v-if="intervalSaving" class="size-4 animate-spin" aria-hidden="true" />
              {{ $t('common.actions.save') }}
            </Button>
          </div>
          <p v-if="intervalError" id="share-interval-hint" class="text-xs text-destructive">
            {{ $t('networking.shares.interval.range', { max: MAX_UPDATE_INTERVAL_HOURS }) }}
          </p>
          <p v-else id="share-interval-hint" class="text-xs text-muted-foreground">
            {{
              intervalHours(selected) === DEFAULT_UPDATE_INTERVAL_HOURS
                ? $t('networking.shares.interval.hintDefault', { fallback: DEFAULT_UPDATE_INTERVAL_HOURS })
                : $t('networking.shares.interval.hint', { hours: intervalHours(selected), fallback: DEFAULT_UPDATE_INTERVAL_HOURS })
            }}
          </p>
        </form>

        <dl class="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
          <div>
            <dt class="text-muted-foreground">{{ $t('networking.shares.columns.format') }}</dt>
            <dd>{{ selected.default_format || $t('networking.shares.formatAuto') }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{{ $t('networking.shares.created') }}</dt>
            <dd>{{ formatRelativeTime(selected.created_at) }}</dd>
          </div>
          <div v-if="selected.rotated_at">
            <dt class="text-muted-foreground">{{ $t('networking.shares.rotatedAt') }}</dt>
            <dd>{{ formatRelativeTime(selected.rotated_at) }}</dd>
          </div>
          <!-- Shown even when there is none: "no expiry" and "expires next week"
               look the same to someone scanning, and only one is safe to hand out. -->
          <div>
            <dt class="text-muted-foreground">{{ $t('networking.shares.expires') }}</dt>
            <dd v-if="selected.expires_at" :title="formatDateTime(selected.expires_at)">
              {{ formatDateTime(selected.expires_at) }}
              <span class="text-muted-foreground">· {{ formatRelativeTime(selected.expires_at) }}</span>
            </dd>
            <dd v-else class="text-muted-foreground">{{ $t('networking.shares.expiry.never') }}</dd>
          </div>
          <!-- Present once the link has rendered since the server started; absent means a full budget. -->
          <div v-if="selected.render_budget">
            <dt class="text-muted-foreground">{{ $t('networking.shares.budget.label') }}</dt>
            <dd
              :class="renderBudgetTone(selected.render_budget) === 'exhausted' ? 'text-destructive' : renderBudgetTone(selected.render_budget) === 'warning' ? 'text-warning-text' : ''"
              data-testid="share-budget"
            >
              {{ $t('networking.shares.budget.remaining', { remaining: selected.render_budget.remaining, burst: selected.render_budget.burst }) }}
              <span class="block text-muted-foreground">{{ $t('networking.shares.budget.refill', { perHour: selected.render_budget.per_hour }) }}</span>
              <span v-if="selected.render_budget.refused && !budgetExhausted(selected)" class="block">
                {{ $t('networking.shares.budget.refused', { n: selected.render_budget.refused }, selected.render_budget.refused) }}
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <template v-if="selected" #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="busyId === selected.id || !shareRefreshable(rendererState(selected))"
          :title="rendererReason(selected)"
          @click="refreshSource(selected)"
        >
          <RefreshCw :class="cn('size-4', busyId === selected.id && 'animate-spin')" aria-hidden="true" />
          {{ $t('networking.shares.refreshSource') }}
        </Button>
        <Button variant="outline" size="sm" :disabled="busyId === selected.id" @click="openExpiry(selected)">
          <CalendarClock class="size-4" aria-hidden="true" />
          {{ $t('networking.shares.expiry.change') }}
        </Button>
        <RowMenu :name="`/${selected.slug}`" :items="menuFor(selected).filter((item) => item.key === 'rotate' || item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <!-- ── publish form, in the side sheet the page's other create forms use ── -->
    <ObjectSheet :open="publishOpen" :title="$t('networking.shares.publishTitle')" @close="publishOpen = false">
      <form v-if="publishOpen" id="share-publish-form" class="space-y-4 text-sm" data-testid="share-publish-form" @submit.prevent="publish">
        <p class="text-muted-foreground">{{ $t('networking.shares.publishDescription') }}</p>
        <div class="grid gap-2">
          <Label>{{ $t('networking.shares.sourceKind') }}</Label>
          <Select v-model="draft.kind">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="plugin" :disabled="!pluginShareAvailable">{{ $t('networking.shares.kindPlugin') }}</SelectItem>
              <SelectItem value="core.proxy_user">{{ $t('networking.shares.kindProxyUser') }}</SelectItem>
            </SelectContent>
          </Select>
          <!-- Plugin absent: the option is there and disabled, and this is why. -->
          <p v-if="!pluginShareAvailable" class="flex items-start gap-1.5 text-xs text-muted-foreground">
            <PlugZap class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {{ canReadPlugins ? $t('platform.publishing.renderer.createUnavailable') : $t('platform.publishing.renderer.createNoAccess') }}
          </p>
        </div>

        <template v-if="draft.kind === 'plugin'">
          <div class="grid gap-2">
            <Label>{{ $t('networking.shares.plugin') }}</Label>
            <Select v-model="draft.pluginId">
              <SelectTrigger class="w-full"><SelectValue :placeholder="$t('networking.shares.pluginPlaceholder')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="plugin in publishablePlugins" :key="plugin.id" :value="plugin.id">
                  {{ plugin.name || plugin.id }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!publishablePlugins.length" class="text-xs text-muted-foreground">
              {{ $t('networking.shares.noPublishablePlugins') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.shares.record') }}</Label>
            <Select v-model="draft.subscriptionId" :disabled="recordsLoading || !records.length">
              <SelectTrigger class="w-full">
                <SelectValue :placeholder="recordsLoading ? $t('common.state.loading') : $t('networking.shares.recordPlaceholder')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="record in records" :key="record.id" :value="record.id">
                  {{ record.display_name || record.name || record.id }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="recordsError" class="text-xs text-destructive">{{ recordsError }}</p>
            <p v-else-if="missingRecord && !draft.subscriptionId" class="text-xs text-warning-text" data-testid="share-record-missing">
              {{ $t('networking.shares.recordMissing', { name: missingRecord }) }}
            </p>
            <p v-else-if="!recordsLoading && !records.length && draft.pluginId" class="text-xs text-muted-foreground">
              {{ $t('networking.shares.noRecords') }}
            </p>
          </div>
        </template>

        <div v-else class="grid gap-2">
          <Label for="share-proxy-user">{{ $t('networking.shares.proxyUser') }}</Label>
          <!-- A choice from the users the server has, like the record picker
               above. Only when the list could not be read does this fall
               back to a typed id, and it says so: a picker that blocked on a
               failed list would make one unreadable endpoint stop publishing. -->
          <template v-if="proxyUsersQuery.loading.value || proxyUsers">
            <Select v-model="draft.proxyUserId" :disabled="proxyUsersQuery.loading.value || !proxyUsers?.length">
              <SelectTrigger id="share-proxy-user" class="w-full">
                <SelectValue
                  :placeholder="proxyUsersQuery.loading.value ? $t('common.state.loading') : $t('networking.shares.proxyUserPlaceholder')"
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="user in proxyUsers" :key="user.id" :value="user.id">
                  <span>{{ user.name || user.id }}</span>
                  <span v-if="user.name && user.name !== user.id" class="ml-2 font-mono text-xs text-muted-foreground">{{ user.id }}</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!proxyUsersQuery.loading.value && !proxyUsers?.length" class="text-xs text-muted-foreground">
              {{ $t('networking.shares.noProxyUsers') }}
            </p>
          </template>
          <template v-else>
            <Input id="share-proxy-user" v-model="draft.proxyUserId" autocomplete="off" spellcheck="false" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.shares.proxyUsersUnread') }}</p>
          </template>
        </div>

        <div class="grid gap-2">
          <Label for="share-slug">{{ $t('networking.shares.slug') }}</Label>
          <Input id="share-slug" v-model="draft.slug" autocomplete="off" spellcheck="false" placeholder="team-nodes" />
          <p v-if="slugError" class="text-xs text-destructive">{{ slugError }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ $t('networking.shares.slugHint') }}</p>
        </div>

        <div class="grid gap-2">
          <Label>{{ $t('networking.shares.defaultFormat') }}</Label>
          <Select v-model="draft.defaultFormat">
            <SelectTrigger class="w-full"><SelectValue :placeholder="$t('networking.shares.formatAuto')" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="plain">plain</SelectItem>
              <SelectItem value="base64">base64</SelectItem>
              <SelectItem value="sing-box">sing-box</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('networking.shares.formatHint') }}</p>
        </div>

        <div class="grid gap-2">
          <Label for="share-publish-interval">{{ $t('networking.shares.interval.label') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="share-publish-interval"
              v-model="draft.interval"
              class="w-24"
              inputmode="numeric"
              autocomplete="off"
              :placeholder="$t('networking.shares.interval.placeholder')"
              :aria-invalid="!!draftIntervalError || undefined"
            />
            <span class="text-xs text-muted-foreground">{{ $t('networking.shares.interval.unit') }}</span>
          </div>
          <p v-if="draftIntervalError" class="text-xs text-destructive">
            {{ $t('networking.shares.interval.range', { max: MAX_UPDATE_INTERVAL_HOURS }) }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            {{ $t('networking.shares.interval.createHint', { fallback: DEFAULT_UPDATE_INTERVAL_HOURS }) }}
          </p>
        </div>

        <ShareExpiryFields v-model="draft.expiry" id-prefix="publish" :now="now" />

        <!-- The server refused the record as a fleet feed; the flag is the operator's to give. -->
        <div
          v-if="fleetFeedRefusal"
          class="space-y-2 rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs"
          :title="fleetFeedRefusal"
          data-testid="share-fleet-refusal"
        >
          <template v-if="fleetFeedRefusalKind === 'unchecked'">
            <p class="font-medium">{{ $t('networking.shares.fleetFeed.refusedUncheckedTitle', { record: draftRecordName }) }}</p>
            <p class="text-muted-foreground">{{ $t('networking.shares.fleetFeed.refusedUncheckedHint') }}</p>
          </template>
          <template v-else>
            <p class="font-medium">{{ $t('networking.shares.fleetFeed.refusedTitle', { record: draftRecordName }) }}</p>
            <p class="text-muted-foreground">{{ $t('networking.shares.fleetFeed.refusedHint') }}</p>
          </template>
          <label class="flex items-start gap-2 text-foreground">
            <Checkbox v-model="draft.fleetCredentials" class="mt-0.5" data-testid="share-fleet-ack" />
            <span>{{ $t(fleetFeedRefusalKind === 'unchecked' ? 'networking.shares.fleetFeed.ackUnchecked' : 'networking.shares.fleetFeed.ack') }}</span>
          </label>
        </div>
      </form>
      <template v-if="publishOpen" #actions>
        <Button type="submit" form="share-publish-form" size="sm" :disabled="!canPublish">
          <RefreshCw v-if="publishing" class="size-4 animate-spin" aria-hidden="true" />
          <Link2 v-else class="size-4" aria-hidden="true" />
          {{ $t('networking.shares.publish') }}
        </Button>
      </template>
    </ObjectSheet>

    <!-- ── expiry ──────────────────────────────────────────────────────── -->
    <!-- Editing the expiry is not destructive, so it does not go through
         ConfirmDialog: nothing a client holds stops working because of it, and
         the URL is untouched. -->
    <Dialog v-model:open="expiryOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.shares.expiry.dialogTitle', { slug: expiryTarget?.slug }) }}</DialogTitle>
          <DialogDescription>{{ $t('networking.shares.expiry.dialogDescription') }}</DialogDescription>
        </DialogHeader>

        <ShareExpiryFields v-model="expiryDraft" id-prefix="edit" :now="now" />

        <DialogFooter>
          <DialogClose as-child>
            <Button variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button :disabled="expirySaving || !!expiryFormError(expiryDraft, now)" @click="saveExpiry">
            <RefreshCw v-if="expirySaving" class="size-4 animate-spin" aria-hidden="true" />
            <CalendarClock v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.save') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- ── rotate / delete confirmation ────────────────────────────────── -->
    <ConfirmDialog
      :open="!!rotateTarget || !!deleteTarget"
      :title="rotateTarget ? $t('networking.shares.rotateTitle') : $t('networking.shares.deleteTitle')"
      :description="rotateTarget
        ? $t('networking.shares.rotateWarning', { slug: rotateTarget.slug })
        : $t('networking.shares.deleteWarning', { slug: deleteTarget?.slug ?? '' })"
      :confirm-label="rotateTarget ? $t('networking.shares.rotate') : $t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :variant="deleteTarget ? 'destructive' : 'default'"
      :pending="!!busyId"
      :confirm-disabled="!confirmMatches"
      @update:open="(open) => { if (!open) { rotateTarget = null; deleteTarget = null; } }"
      @confirm="confirmDestructive"
    >
      <div class="grid gap-2">
        <Label for="share-confirm">
          {{ $t('networking.shares.confirmPrompt', { slug: (rotateTarget ?? deleteTarget)?.slug }) }}
        </Label>
        <Input
          id="share-confirm"
          v-model="confirmText"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="confirmError || undefined"
        />
        <p v-if="confirmError" class="text-xs text-destructive">
          {{ $t('networking.shares.confirmMismatch') }}
        </p>
      </div>
    </ConfirmDialog>

    <!-- After every dialog it can open over, so it stacks on top. -->
    <StepUpDialog
      :step-up="revealStepUp"
      :title="$t('networking.shares.reveal.title', { slug: selected?.slug ?? '' })"
      :description="$t('networking.shares.reveal.description')"
      :submit-label="$t('networking.shares.reveal.submit')"
      :audit="$t('networking.shares.reveal.audit')"
      test-id="share-step-up"
    />
  </section>
</template>
