<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { CalendarClock, Copy, KeyRound, Link2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-vue-next";

import {
  expiryFormError,
  expiryInstant,
  expiryLabel,
  isExpired,
  type DurationUnit,
  type ExpiryForm,
  type ExpiryMode,
} from "./shareExpiryModel";

import { api, ApiError } from "@/lib/api";
import type {
  ShareSource,
  SubscriptionShareCreateRequest,
  SubscriptionShareUpdateRequest,
  SubscriptionShareView,
} from "@/lib/api";

/**
 * Subscription shares — the public URLs the server serves.
 *
 * This lives in the dashboard rather than in the Sub-Store plugin on purpose.
 * Shares are core-owned: the route, the token comparison, the rate limit and
 * the audit trail all belong to the server, and the plugin frame runs with
 * `connect-src 'none'` and can only reach methods its signed manifest declares.
 * It has no way to call `/api/subscription-shares`, and giving it one would
 * hand token management to plugin code.
 *
 * The token is shown in full, permanently. The server returns it deliberately
 * for the same reason: the URL is copied out of here repeatedly, and a
 * credential that is only visible once gets written down somewhere worse.
 */

const shares = ref<SubscriptionShareView[]>([]);
const loading = ref(true);
const loadError = ref("");
const actionError = ref("");
const notice = ref("");
const busyId = ref<string | null>(null);
const creating = ref(false);
const confirmingDelete = ref<string | null>(null);
const rotatingConfirm = ref<string | null>(null);
/** The share whose expiry is being edited, and what it is being set to. */
const editingExpiry = ref<string | null>(null);
const editExpiresOn = ref("");

const form = ref<{
  slug: string;
  kind: ShareSource["kind"];
  pluginId: string;
  subscriptionId: string;
  proxyUserId: string;
  defaultFormat: string;
  expiryMode: ExpiryMode;
  durationAmount: number;
  durationUnit: DurationUnit;
  expiresOn: string;
}>({
  slug: "",
  kind: "plugin",
  pluginId: "latticenet.sub-store",
  subscriptionId: "",
  proxyUserId: "",
  defaultFormat: "",
  expiryMode: "never",
  durationAmount: 1,
  durationUnit: "year",
  expiresOn: "",
});

/** The shape the extracted model takes, read off the form. */
function expiryForm(): ExpiryForm {
  return {
    mode: form.value.expiryMode,
    amount: form.value.durationAmount,
    unit: form.value.durationUnit,
    on: form.value.expiresOn,
  };
}

function expiryFromForm(): string | null {
  return expiryInstant(expiryForm(), Date.now())?.toISOString() ?? null;
}

const expiryError = computed(() => expiryFormError(expiryForm(), Date.now()));

/** Mirrors the server's `shareSlugRe`. Failing here saves a round trip and
 *  states the rule; the server still owns the decision. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const slugError = computed(() => {
  const slug = form.value.slug.trim();
  if (!slug) return "";
  if (!SLUG_RE.test(slug)) {
    return "Lowercase letters, digits and hyphens, starting with a letter or digit.";
  }
  if (shares.value.some((s) => s.slug === slug)) return "A share with this slug already exists.";
  return "";
});

const formValid = computed(() => {
  if (!form.value.slug.trim() || slugError.value || expiryError.value) return false;
  return form.value.kind === "plugin"
    ? !!form.value.pluginId.trim() && !!form.value.subscriptionId.trim()
    : !!form.value.proxyUserId.trim();
});

/** The origin the browser is on is the origin the share is served from, so the
 *  displayed URL is the real one rather than a guess at LATTICE_PUBLIC_URL. */
function shareUrl(share: SubscriptionShareView): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/sub/${share.slug}/${share.token}`;
}

function sourceLabel(source: ShareSource): string {
  return source.kind === "plugin"
    ? `${source.plugin_id} · ${source.subscription_id}`
    : `proxy user ${source.proxy_user_id}`;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    shares.value = await api.subscriptionShares.list();
  } catch (error) {
    loadError.value = describe(error, "Shares could not be loaded");
  } finally {
    loading.value = false;
  }
}

async function copy(share: SubscriptionShareView): Promise<void> {
  actionError.value = "";
  try {
    await navigator.clipboard.writeText(shareUrl(share));
    notice.value = `Copied the URL for ${share.slug}.`;
  } catch {
    actionError.value = "The clipboard is unavailable — select the URL and copy it manually.";
  }
}

async function create(): Promise<void> {
  if (!formValid.value || creating.value) return;
  creating.value = true;
  actionError.value = "";
  notice.value = "";
  try {
    const source: ShareSource =
      form.value.kind === "plugin"
        ? {
            kind: "plugin",
            plugin_id: form.value.pluginId.trim(),
            subscription_id: form.value.subscriptionId.trim(),
          }
        : { kind: "core.proxy_user", proxy_user_id: form.value.proxyUserId.trim() };
    const body: SubscriptionShareCreateRequest = {
      slug: form.value.slug.trim(),
      source,
      default_format: form.value.defaultFormat.trim() || undefined,
      expires_at: expiryFromForm() ?? undefined,
    };
    const created = await api.subscriptionShares.create(body);
    shares.value = [...shares.value, created];
    notice.value = `Published ${created.slug}. The URL below is live now.`;
    form.value.slug = "";
    form.value.subscriptionId = "";
    form.value.proxyUserId = "";
  } catch (error) {
    actionError.value = describe(error, "Share could not be created");
  } finally {
    creating.value = false;
  }
}

function startExpiryEdit(share: SubscriptionShareView): void {
  editingExpiry.value = editingExpiry.value === share.id ? null : share.id;
  // Prefilled with what it already is, so "extend by a week" is an edit rather
  // than a recall exercise.
  editExpiresOn.value = share.expires_at ? new Date(share.expires_at).toISOString().slice(0, 10) : "";
  actionError.value = "";
}

async function saveExpiry(share: SubscriptionShareView, clear: boolean): Promise<void> {
  busyId.value = share.id;
  actionError.value = "";
  notice.value = "";
  try {
    let body: SubscriptionShareUpdateRequest;
    if (clear) {
      // Omitting the field would leave the expiry alone, which is why the
      // server takes an explicit flag rather than a null.
      body = { clear_expiry: true };
    } else {
      const end = new Date(`${editExpiresOn.value}T23:59:59`);
      if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
        actionError.value = "Pick a date in the future.";
        return;
      }
      body = { expires_at: end.toISOString() };
    }
    const updated = await api.subscriptionShares.update(share.id, body);
    shares.value = shares.value.map((s) => (s.id === updated.id ? updated : s));
    editingExpiry.value = null;
    notice.value = clear
      ? `${updated.slug} no longer expires.`
      : `${updated.slug} now expires ${new Date(updated.expires_at ?? "").toLocaleString()}.`;
  } catch (error) {
    actionError.value = describe(error, "The expiry could not be changed");
  } finally {
    busyId.value = null;
  }
}

async function rotate(share: SubscriptionShareView): Promise<void> {
  busyId.value = share.id;
  actionError.value = "";
  notice.value = "";
  try {
    const rotated = await api.subscriptionShares.rotate(share.id);
    shares.value = shares.value.map((s) => (s.id === rotated.id ? rotated : s));
    notice.value = `Rotated ${rotated.slug}. The previous URL now returns 404 like any unknown path — every client using it must be given the new one.`;
    rotatingConfirm.value = null;
  } catch (error) {
    actionError.value = describe(error, "Share could not be rotated");
  } finally {
    busyId.value = null;
  }
}

async function refresh(share: SubscriptionShareView): Promise<void> {
  busyId.value = share.id;
  actionError.value = "";
  notice.value = "";
  try {
    await api.subscriptionShares.refresh(share.id);
    notice.value = `Refreshed ${share.slug}.`;
  } catch (error) {
    // A provider that cannot be reached is not a broken share: the last good
    // snapshot keeps being served. Say both halves.
    actionError.value = `${describe(error, "Refresh failed")} The last good snapshot is still being served.`;
  } finally {
    busyId.value = null;
  }
}

async function remove(share: SubscriptionShareView): Promise<void> {
  busyId.value = share.id;
  actionError.value = "";
  notice.value = "";
  try {
    await api.subscriptionShares.remove(share.id);
    shares.value = shares.value.filter((s) => s.id !== share.id);
    notice.value = `Deleted ${share.slug}. The URL is no longer served.`;
    confirmingDelete.value = null;
  } catch (error) {
    actionError.value = describe(error, "Share could not be deleted");
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>Subscription shares</h1>
        <p class="page-sub">
          The public URLs this server serves. Anything that is not a valid share returns an empty
          404 — a prober cannot tell an existing share from a missing one.
        </p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load">
        <RefreshCw :size="15" /> Reload
      </button>
    </header>

    <p v-if="actionError" class="banner banner-error" role="alert">{{ actionError }}</p>
    <p v-else-if="notice" class="banner banner-ok" role="status">{{ notice }}</p>

    <section class="card">
      <h2>Publish a subscription</h2>
      <div class="grid">
        <label class="field">
          <span>Slug</span>
          <input v-model="form.slug" type="text" spellcheck="false" placeholder="share-for-me" />
          <small v-if="slugError" class="err">{{ slugError }}</small>
          <small v-else class="hint">
            Appears in the URL and in reverse-proxy logs, so it is a label rather than a secret.
          </small>
        </label>

        <label class="field">
          <span>Source</span>
          <select v-model="form.kind">
            <option value="plugin">Plugin subscription</option>
            <option value="core.proxy_user">Proxy user</option>
          </select>
        </label>

        <template v-if="form.kind === 'plugin'">
          <label class="field">
            <span>Plugin id</span>
            <input v-model="form.pluginId" type="text" spellcheck="false" />
          </label>
          <label class="field">
            <span>Subscription id</span>
            <input
              v-model="form.subscriptionId"
              type="text"
              spellcheck="false"
              placeholder="As listed in the plugin's Subscriptions tab"
            />
          </label>
        </template>
        <label v-else class="field">
          <span>Proxy user id</span>
          <input v-model="form.proxyUserId" type="text" spellcheck="false" />
        </label>

        <label class="field">
          <span>Default format</span>
          <input v-model="form.defaultFormat" type="text" spellcheck="false" placeholder="Optional" />
        </label>

        <label class="field">
          <span>Expires</span>
          <select v-model="form.expiryMode">
            <option value="never">Never</option>
            <option value="duration">After a period</option>
            <option value="datetime">On a date</option>
          </select>
          <small class="hint">
            An expired share answers exactly like an unknown path, so nothing about it leaks —
            including that it ever existed.
          </small>
        </label>

        <label v-if="form.expiryMode === 'duration'" class="field">
          <span>For</span>
          <div class="expiry-row">
            <input v-model.number="form.durationAmount" type="number" min="1" step="1" />
            <select v-model="form.durationUnit">
              <option value="day">Days</option>
              <option value="month">Months</option>
              <option value="quarter">Quarters</option>
              <option value="year">Years</option>
            </select>
          </div>
          <small v-if="expiryError" class="err">{{ expiryError }}</small>
          <small v-else class="hint">Counted from the moment you publish.</small>
        </label>

        <label v-if="form.expiryMode === 'datetime'" class="field">
          <span>Until</span>
          <input v-model="form.expiresOn" type="date" />
          <small v-if="expiryError" class="err">{{ expiryError }}</small>
          <small v-else class="hint">Stops working at the end of that day, in your timezone.</small>
        </label>
      </div>

      <div class="actions">
        <button class="btn btn-primary" type="button" :disabled="!formValid || creating" @click="create">
          <Loader2 v-if="creating" :size="15" class="spin" />
          <Plus v-else :size="15" />
          Publish
        </button>
      </div>
    </section>

    <section class="card">
      <h2>Published</h2>

      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="loadError" class="banner banner-error" role="alert">{{ loadError }}</p>
      <p v-else-if="!shares.length" class="muted">
        Nothing is published. A subscription stored in the plugin is not reachable until it has a
        share here.
      </p>

      <ul v-else class="share-list">
        <li v-for="share in shares" :key="share.id" class="share">
          <div class="share-head">
            <div class="share-id">
              <Link2 :size="15" />
              <strong>{{ share.slug }}</strong>
              <span class="chip" :class="share.enabled ? 'chip-ok' : 'chip-off'">
                {{ share.enabled ? "live" : "disabled" }}
              </span>
            </div>
            <div class="share-actions">
              <button class="icon" type="button" title="Copy URL" @click="copy(share)">
                <Copy :size="15" />
              </button>
              <button
                class="icon"
                type="button"
                title="Fetch from the provider now"
                :disabled="busyId === share.id"
                @click="refresh(share)"
              >
                <RefreshCw :size="15" />
              </button>
              <button
                class="icon"
                type="button"
                title="Rotate the token"
                :disabled="busyId === share.id"
                @click="rotatingConfirm = rotatingConfirm === share.id ? null : share.id"
              >
                <KeyRound :size="15" />
              </button>
              <button
                class="icon"
                type="button"
                title="Change when this expires"
                :aria-label="`Change when ${share.slug} expires`"
                :disabled="busyId === share.id"
                @click="startExpiryEdit(share)"
              >
                <CalendarClock :size="15" />
              </button>
              <button
                class="icon danger"
                type="button"
                title="Delete the share"
                :disabled="busyId === share.id"
                @click="confirmingDelete = confirmingDelete === share.id ? null : share.id"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </div>

          <!-- Permanently visible, by request and by design. -->
          <code class="share-url">{{ shareUrl(share) }}</code>

          <p class="share-meta">
            {{ sourceLabel(share.source) }}
            <template v-if="share.default_format"> · {{ share.default_format }}</template>
            · <span :class="{ 'expiry-gone': isExpired(share.expires_at, Date.now()) }">{{
              expiryLabel(share.expires_at, Date.now())
            }}</span>
            <template v-if="share.rotated_at"> · rotated {{ new Date(share.rotated_at).toLocaleString() }}</template>
          </p>

          <div v-if="editingExpiry === share.id" class="banner">
            <label class="field field-inline">
              <span>Expires at the end of</span>
              <input v-model="editExpiresOn" type="date" />
            </label>
            <button class="btn btn-sm" type="button" @click="editingExpiry = null">Cancel</button>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="busyId === share.id"
              @click="saveExpiry(share, true)"
            >
              Never expire
            </button>
            <button
              class="btn btn-sm btn-primary"
              type="button"
              :disabled="busyId === share.id"
              @click="saveExpiry(share, false)"
            >
              Save
            </button>
          </div>

          <p v-if="rotatingConfirm === share.id" class="banner banner-warn">
            Rotating replaces the token. Every client using the current URL stops working until you
            give them the new one.
            <button class="btn btn-sm" type="button" @click="rotatingConfirm = null">Keep</button>
            <button class="btn btn-sm btn-primary" type="button" @click="rotate(share)">Rotate</button>
          </p>

          <p v-if="confirmingDelete === share.id" class="banner banner-warn">
            Delete <strong>{{ share.slug }}</strong>? The URL stops being served immediately. The
            subscription itself stays in the plugin.
            <button class="btn btn-sm" type="button" @click="confirmingDelete = null">Keep</button>
            <button class="btn btn-sm btn-danger" type="button" @click="remove(share)">Delete</button>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.expiry-row {
  display: flex;
  gap: 8px;
}
.expiry-row input {
  flex: 1 1 5rem;
  min-width: 0;
}
/* An expired share is still listed, because deleting it is the operator's
   call — but it must not read like a live one. */
.expiry-gone {
  color: var(--danger, #b52b2b);
  font-weight: 600;
}
.field-inline {
  flex: 1 1 14rem;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
}

.page-sub {
  margin: 0;
  max-width: 70ch;
  color: var(--text-muted, #8b96a5);
  font-size: 14px;
  line-height: 1.6;
}

.card {
  padding: 18px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 12px;
  background: var(--surface, #161c26);
}

.card h2 {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 700;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.field span {
  font-weight: 600;
}

.field input,
.field select {
  padding: 8px 10px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 8px;
  background: var(--surface-2, #0d1117);
  color: inherit;
  font-size: 13px;
}

.hint,
.err {
  font-size: 12px;
  line-height: 1.45;
}

.hint {
  color: var(--text-muted, #8b96a5);
}

.err {
  color: #f87171;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  border-color: transparent;
  background: var(--accent, #2dd4bf);
  color: #04211d;
}

.btn-danger {
  border-color: #f87171;
  color: #f87171;
}

.btn-sm {
  padding: 4px 9px;
  font-size: 12px;
}

.icon {
  display: inline-flex;
  padding: 6px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon.danger {
  color: #f87171;
}

.share-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.share {
  padding: 14px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 10px;
  background: var(--surface-2, #0d1117);
}

.share-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.share-id {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.share-actions {
  display: inline-flex;
  gap: 6px;
}

.share-url {
  display: block;
  padding: 9px 11px;
  border: 1px solid var(--border, #242d3a);
  border-radius: 8px;
  background: var(--surface, #161c26);
  font-size: 12.5px;
  /* The token makes this long; wrapping beats a hidden overflow when the whole
     point is that the operator can read and copy it. */
  word-break: break-all;
}

.share-meta {
  margin: 9px 0 0;
  color: var(--text-muted, #8b96a5);
  font-size: 12.5px;
}

.chip {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.chip-ok {
  background: rgba(45, 212, 191, 0.15);
  color: #2dd4bf;
}

.chip-off {
  background: rgba(139, 150, 165, 0.18);
  color: #8b96a5;
}

.banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.55;
}

.banner-error {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
}

.banner-ok {
  background: rgba(45, 212, 191, 0.12);
  color: #2dd4bf;
}

.banner-warn {
  background: rgba(250, 204, 21, 0.12);
  color: #facc15;
}

.muted {
  color: var(--text-muted, #8b96a5);
  font-size: 13.5px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
