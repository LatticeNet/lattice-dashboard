<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { AlertTriangle, PlugZap, RefreshCw } from "lucide-vue-next";

import { api, type PluginInterfaceContract, type PluginUIRuntime } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PluginBridgeSession, resolvePluginFrameURL, type BridgeHostMessage } from "./pluginBridgeModel";
import {
  PluginFrameLifecycle,
  pluginFrameIsBusy,
  pluginFramePhase,
} from "./pluginFrameModel";
import { classifyPluginNavigateMessage, isExpectedPluginFrameOrigin } from "./pluginNavigationModel";
import { claimViewportPane } from "@/layout/viewportPane";

const props = defineProps<{
  pluginId: string;
  pluginName: string;
  pluginVersion?: string;
  pluginRoute: string;
  runtime: PluginUIRuntime;
  interfaces: PluginInterfaceContract[];
}>();

/** How long a loaded document gets to answer before the host says so. */
const HANDSHAKE_TIMEOUT_MS = 8_000;

const lifecycle = new PluginFrameLifecycle({ createNonce });
const router = useRouter();

const frame = ref<HTMLIFrameElement | null>(null);
const loaded = ref(false);
const failed = ref(false);
const frameDown = ref(false);
const nonce = ref(lifecycle.nonce);

/**
 * The document has arrived but the plugin has not spoken yet. Tracked
 * separately from `loaded` (which means the handshake landed) so the host can
 * say which of the two waits it is in instead of showing one undifferentiated
 * blank.
 */
const documentLoaded = ref(false);
const handshakeExpired = ref(false);

/**
 * The frame is a viewport, not a document.
 *
 * The host used to size the iframe to the height the plugin reported, clamped
 * to [320, 2400]. Every page taller than that ceiling (sub-store's subscription
 * list, vpn-core's Lines table) got a frame shorter than its own content, so the
 * plugin document scrolled inside a frame that was itself inside a scrolling
 * page: two nested scrollbars, and the inner one unreachable until the outer one
 * had been scrolled to the bottom. A frame sized to content also cannot be a
 * viewport, which is why `position: fixed` and `position: sticky` do not work
 * inside a plugin and why an overlay has no way to learn how tall the window is.
 *
 * So the pane fills the shell's main region exactly and the plugin scrolls
 * inside it. One scrollbar. `100vh`, `fixed` and `sticky` resolve against the
 * visible window because the frame now is the visible window. The height never
 * depends on anything the plugin says, so nothing jumps when the plugin first
 * reports and no reported number can make the host allocate a larger box: the
 * bridge still accepts `lattice.plugin.resize` for protocol compatibility, and
 * the host no longer wires it to layout.
 */
let releaseViewportPane: (() => void) | undefined;

const phase = computed(() =>
  pluginFramePhase({
    documentLoaded: documentLoaded.value,
    handshakeComplete: loaded.value,
    handshakeExpired: handshakeExpired.value,
    frameDown: frameDown.value,
    loadError: failed.value && !handshakeExpired.value,
  }),
);

const busy = computed(() => pluginFrameIsBusy(phase.value));

// Re-keying the iframe makes Vue discard the element together with its document.
// Rotation must never be expressed as a bare `src` reassignment: the rotated URL
// differs from the live one only in its fragment, which the browser resolves as a
// same-document navigation. No reload, no `load` event. A fresh element has no
// current document to compare against, so every rotation is a real navigation and
// always fires `load`.
const frameEpoch = ref(0);

const frameSource = computed(() => props.runtime.bridge_version === "1"
  ? resolvePluginFrameURL(
      props.runtime.entry_url,
      window.location.origin,
      props.pluginId,
      props.runtime.asset_digest,
      nonce.value,
    )
  : undefined);

let session: PluginBridgeSession | undefined;
let sourceWindow: Window | null = null;
let themeObserver: MutationObserver | undefined;
let handshakeComplete = false;
let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

function clearHandshakeTimer() {
  if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
  handshakeTimer = undefined;
}

function failHandshake() {
  if (handshakeComplete) return;
  teardownSession();
  // Deliberately NOT the same state as "could not load": the document is there
  // and simply never answered, which is the plugin's problem to report, and the
  // operator needs to be told which of the two happened.
  handshakeExpired.value = true;
  loaded.value = false;
}

function startHandshakeTimer() {
  clearHandshakeTimer();
  if (handshakeComplete) return;
  handshakeTimer = setTimeout(failHandshake, HANDSHAKE_TIMEOUT_MS);
}

function markReady() {
  if (handshakeComplete) return;
  handshakeComplete = true;
  clearHandshakeTimer();
  loaded.value = true;
  failed.value = false;
  handshakeExpired.value = false;
}

/** Remount the frame under a fresh nonce. Used by the operator-facing retry. */
function retry() {
  teardownSession();
  loaded.value = false;
  failed.value = false;
  frameDown.value = false;
  documentLoaded.value = false;
  handshakeExpired.value = false;
  nonce.value = lifecycle.reset();
  frameEpoch.value += 1;
}

function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function colorScheme(): string {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--destructive",
  "--ring",
];

function designTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKEN_NAMES.map((name) => [name, styles.getPropertyValue(name).trim()]));
}

function postToFrame(message: BridgeHostMessage) {
  sourceWindow?.postMessage(message, "*");
}

function teardownSession() {
  session?.dispose();
  session = undefined;
  sourceWindow = null;
  clearHandshakeTimer();
  handshakeComplete = false;
}

function armSession() {
  const nextSource = frame.value?.contentWindow ?? null;
  if (!nextSource) return;
  session?.dispose();
  clearHandshakeTimer();
  handshakeComplete = false;
  sourceWindow = nextSource;
  session = new PluginBridgeSession({
    pluginId: props.pluginId,
    pluginVersion: props.pluginVersion ?? "",
    pluginRoute: props.pluginRoute,
    bridgeVersion: props.runtime.bridge_version,
    nonce: nonce.value,
    sourceWindow: nextSource,
    interfaces: props.interfaces,
    locale: navigator.language || "en",
    colorScheme: colorScheme(),
    designTokens: designTokens(),
    call: (service, method, payload, signal) =>
      api.plugins.call(props.pluginId, service, method, payload, signal),
    post: postToFrame,
    ready: markReady,
  });
}

function onMessage(event: MessageEvent) {
  // Plugin-requested host navigation (e.g. Sub-Store's "publish a share"
  // button → the subscription-shares deep link). The frame runs connect-src
  // 'none', so postMessage is its only outbound channel and the host performs
  // the route change for it. Identity is pinned to the armed frame window and
  // its (opaque, sandboxed) origin; the route must be a strictly internal
  // dashboard path. The worst a bad frame can do is move the host to another
  // dashboard page. Anything else is dropped without disturbing the bridge.
  const navigation = classifyPluginNavigateMessage(event.data);
  if (navigation.kind === "navigate") {
    if (event.source === sourceWindow && isExpectedPluginFrameOrigin(event.origin, window.location.origin)) {
      void router.push(navigation.route);
    } else {
      console.debug("[plugin-frame] ignored navigate from an unexpected source or origin", event.origin);
    }
    return;
  }
  if (navigation.kind === "invalid") {
    console.debug("[plugin-frame] ignored malformed or non-internal navigate request");
    return;
  }
  void session?.handle({ source: event.source, data: event.data });
}

function onLoad() {
  documentLoaded.value = true;
  const outcome = lifecycle.noteLoad();
  if (outcome.action === "handshake") {
    startHandshakeTimer();
    return;
  }

  // Every load after the first replaced the document underneath a stable
  // WindowProxy. Revoke the bridge and abort its in-flight calls before the new
  // document can reach the host.
  teardownSession();
  loaded.value = false;
  documentLoaded.value = false;

  if (outcome.action === "exhausted") {
    frameDown.value = true;
    failed.value = true;
    return;
  }

  failed.value = false;
  nonce.value = outcome.nonce;
  frameEpoch.value += 1;
}

function onError() {
  clearHandshakeTimer();
  failed.value = true;
  loaded.value = false;
  documentLoaded.value = false;
}

// The remounted element is a different iframe, so it must be re-armed before its
// document can post `ready`. Same ordering guarantee as the initial mount.
watch(frameEpoch, async () => {
  await nextTick();
  armSession();
});

onMounted(async () => {
  // Claimed before the early return below: the failure panel is positioned
  // against this pane too, so it needs the pane to exist even when no frame
  // does. Released exactly once, on teardown.
  releaseViewportPane = claimViewportPane();
  if (!frameSource.value) {
    failed.value = true;
    return;
  }
  window.addEventListener("message", onMessage);
  themeObserver = new MutationObserver(() => session?.updateTheme(colorScheme(), designTokens()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  await nextTick();
  armSession();
});

onBeforeUnmount(() => {
  releaseViewportPane?.();
  releaseViewportPane = undefined;
  window.removeEventListener("message", onMessage);
  themeObserver?.disconnect();
  teardownSession();
});
</script>

<template>
  <!--
    `absolute inset-0` against the shell's main region, which the claim above
    turns into the containing block. The pane therefore fills the visible area
    exactly however many wrappers the shell puts in between, and never adds
    height of its own for the outer region to scroll.
  -->
  <div class="absolute inset-0 overflow-hidden bg-background">
    <iframe
      v-if="frameSource && !frameDown"
      :key="frameEpoch"
      ref="frame"
      :src="frameSource"
      :title="pluginName"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      class="block h-full w-full border-0 bg-background"
      @load="onLoad"
      @error="onError"
    />

    <!--
      A plugin frame takes seconds to become useful, and until it does the host
      owns the surface. The previous state here was one small spinner centred in
      a full-height box, which on a wide display is indistinguishable from a
      finished, empty page. This is the same skeleton language the rest of the
      console uses for a pending list, so the page reads as loading. It is
      absolutely positioned and therefore adds no height of its own: when the
      plugin reports its real height, nothing jumps.
    -->
    <div
      v-if="busy"
      class="pointer-events-none absolute inset-0 bg-background p-6"
      role="status"
      aria-live="polite"
    >
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <div class="space-y-2">
          <Skeleton class="h-6 w-56 rounded-md" />
          <Skeleton class="h-4 w-80 rounded-md" />
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <Skeleton v-for="n in 3" :key="n" class="h-20 rounded-lg" />
        </div>
        <div class="space-y-2">
          <Skeleton v-for="n in 6" :key="n" class="h-10 w-full rounded-md" />
        </div>
      </div>
      <p class="sr-only">
        {{ phase === 'handshaking'
          ? $t('pluginViews.frame.starting', { plugin: pluginName })
          : $t('pluginViews.frame.loading', { plugin: pluginName }) }}
      </p>
    </div>

    <!--
      Two different failures, said differently. A frame that never loaded is the
      host's or the network's problem; a frame that loaded and never answered is
      the plugin's, and it is the case the plugins themselves already model as a
      expired handshake.
    -->
    <div
      v-else-if="phase === 'unresponsive' || phase === 'unavailable'"
      class="absolute inset-0 grid place-items-center bg-background p-6"
      role="status"
    >
      <div class="flex max-w-md flex-col items-center gap-3 text-center">
        <component
          :is="phase === 'unresponsive' ? PlugZap : AlertTriangle"
          class="size-5"
          :class="phase === 'unresponsive' ? 'text-warning' : 'text-destructive'"
          aria-hidden="true"
        />
        <div class="space-y-1">
          <p class="text-sm font-medium text-foreground">
            {{ phase === 'unresponsive'
              ? $t('pluginViews.frame.unresponsiveTitle', { plugin: pluginName })
              : $t('pluginViews.frame.unavailableTitle', { plugin: pluginName }) }}
          </p>
          <p class="text-sm text-muted-foreground">
            {{ phase === 'unresponsive'
              ? $t('pluginViews.frame.unresponsiveDescription', { seconds: Math.round(HANDSHAKE_TIMEOUT_MS / 1000) })
              : $t('pluginViews.frame.unavailableDescription') }}
          </p>
        </div>
        <Button variant="outline" size="sm" @click="retry">
          <RefreshCw class="size-4" aria-hidden="true" />
          {{ $t('common.actions.retry') }}
        </Button>
      </div>
    </div>
  </div>
</template>
