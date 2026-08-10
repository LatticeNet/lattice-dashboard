<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Copy, KeyRound, Link2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-vue-next";

import { api, ApiError } from "@/lib/api";
import type {
  ShareSource,
  SubscriptionShareCreateRequest,
  SubscriptionShareView,
} from "@/lib/api";
import { SHARE_SLUG_RE, suggestShareSlug } from "./subscriptionSharesModel";

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

const form = ref<{ slug: string; kind: ShareSource["kind"]; pluginId: string; subscriptionId: string; proxyUserId: string; defaultFormat: string }>({
  slug: "",
  kind: "plugin",
  pluginId: "latticenet.sub-store",
  subscriptionId: "",
  proxyUserId: "",
  defaultFormat: "",
});

const SLUG_RE = SHARE_SLUG_RE;

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
  if (!form.value.slug.trim() || slugError.value) return false;
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

const route = useRoute();
const router = useRouter();
const createSection = ref<HTMLElement | null>(null);
const slugInput = ref<HTMLInputElement | null>(null);

/** The identity fields a deep link writes. pluginId keeps its Sub-Store
 *  default and defaultFormat is cosmetic, so neither counts as "typed". */
function formTouched(): boolean {
  return !!(form.value.slug.trim() || form.value.subscriptionId.trim() || form.value.proxyUserId.trim());
}

/**
 * Consume the subscription → share deep link
 * (/network/subscription-shares?create=1&for=<name>) that the Sub-Store plugin
 * frame asks the host to navigate to. If the operator has already typed into
 * the form, the draft wins: nothing is overwritten and the params are left in
 * the URL, so the link can still be applied after the draft is discarded or
 * published.
 */
function applyShareDeepLink(): void {
  if (route.query.create !== "1") return;
  const rawFor = route.query.for;
  const name = (Array.isArray(rawFor) ? rawFor[0] : rawFor)?.trim();
  if (!name || formTouched()) return;
  form.value.kind = "plugin";
  form.value.subscriptionId = name;
  // "" on a slug collision or an un-slugifiable name — the operator picks one.
  form.value.slug = suggestShareSlug(name, shares.value.map((share) => share.slug));
  // Strip the params so a refresh does not re-trigger the prefill.
  const query = { ...route.query };
  delete query.create;
  delete query.for;
  void router.replace({ query });
  void nextTick(() => {
    createSection.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    slugInput.value?.focus({ preventScroll: true });
  });
}

onMounted(async () => {
  // The slug suggestion checks collisions against the loaded shares, so the
  // deep link applies only after the first load settles.
  await load();
  applyShareDeepLink();
});
watch(() => route.query, applyShareDeepLink);
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

    <section ref="createSection" class="card">
      <h2>Publish a subscription</h2>
      <div class="grid">
        <label class="field">
          <span>Slug</span>
          <input ref="slugInput" v-model="form.slug" type="text" spellcheck="false" placeholder="share-for-me" />
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

      <div v-if="loading" class="share-skeletons" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="skeleton-block share-skeleton" />
      </div>
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
            <template v-if="share.rotated_at"> · rotated {{ new Date(share.rotated_at).toLocaleString() }}</template>
          </p>

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

/* Skeleton rows share the global .skeleton-block pulse; only their shape and
   tint are local (this view keeps its own surface tokens — a raw --accent
   block would glare on the dark card in light themes). */
.share-skeletons {
  display: grid;
  gap: 12px;
}

.share-skeleton {
  height: 96px;
  background: var(--border, #242d3a);
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
