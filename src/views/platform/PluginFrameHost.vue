<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { AlertTriangle, LoaderCircle } from "lucide-vue-next";

import { api, type PluginInterfaceContract, type PluginUIRuntime } from "@/lib/api";
import { PluginBridgeSession, resolvePluginFrameURL, type BridgeHostMessage } from "./pluginBridgeModel";

const props = defineProps<{
  pluginId: string;
  pluginName: string;
  pluginVersion?: string;
  pluginRoute: string;
  runtime: PluginUIRuntime;
  interfaces: PluginInterfaceContract[];
}>();

const frame = ref<HTMLIFrameElement | null>(null);
const loaded = ref(false);
const failed = ref(false);
const frameHeight = ref(720);
const nonce = ref(createNonce());
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
let completedLoad = false;
let rotatingNonce = false;
let handshakeComplete = false;
let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

function clearHandshakeTimer() {
  if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
  handshakeTimer = undefined;
}

function failHandshake() {
  if (handshakeComplete) return;
  session?.dispose();
  session = undefined;
  sourceWindow = null;
  failed.value = true;
  loaded.value = false;
}

function startHandshakeTimer() {
  clearHandshakeTimer();
  if (handshakeComplete) return;
  handshakeTimer = setTimeout(failHandshake, 8_000);
}

function markReady() {
  if (handshakeComplete) return;
  handshakeComplete = true;
  clearHandshakeTimer();
  loaded.value = true;
  failed.value = false;
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
    resize: (height) => { frameHeight.value = height; },
    ready: markReady,
  });
}

function onMessage(event: MessageEvent) {
  void session?.handle({ source: event.source, data: event.data });
}

async function onLoad() {
  if (rotatingNonce) {
    rotatingNonce = false;
    completedLoad = true;
    startHandshakeTimer();
    return;
  }
  if (completedLoad) {
    // A reload or in-frame navigation replaces the document without replacing
    // its WindowProxy. Revoke the old bridge before the new document can reuse
    // its fragment nonce, then navigate back to the verified entrypoint with a
    // fresh nonce and require a new ready/init handshake.
    session?.dispose();
    session = undefined;
    sourceWindow = null;
    clearHandshakeTimer();
    handshakeComplete = false;
    nonce.value = createNonce();
    rotatingNonce = true;
    loaded.value = false;
    failed.value = false;
    await nextTick();
    armSession();
    return;
  }
  completedLoad = true;
  startHandshakeTimer();
}

function onError() {
  clearHandshakeTimer();
  failed.value = true;
  loaded.value = false;
}

onMounted(async () => {
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
  window.removeEventListener("message", onMessage);
  themeObserver?.disconnect();
  clearHandshakeTimer();
  session?.dispose();
  session = undefined;
  sourceWindow = null;
});
</script>

<template>
  <div class="relative min-h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-background">
    <iframe
      v-if="frameSource"
      ref="frame"
      :src="frameSource"
      :title="pluginName"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      class="block w-full border-0 bg-background"
      :style="{ height: `${frameHeight}px`, minHeight: 'calc(100vh - 3.5rem)' }"
      @load="onLoad"
      @error="onError"
    />

    <div
      v-if="!loaded && !failed"
      class="pointer-events-none absolute inset-0 grid min-h-[24rem] place-items-center bg-background"
      aria-live="polite"
    >
      <LoaderCircle class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">Loading plugin interface</span>
    </div>

    <div v-else-if="failed" class="absolute inset-0 grid min-h-[24rem] place-items-center bg-background p-6">
      <div class="flex max-w-sm flex-col items-center gap-3 text-center">
        <AlertTriangle class="size-5 text-destructive" aria-hidden="true" />
        <p class="text-sm font-medium text-foreground">Plugin interface unavailable</p>
      </div>
    </div>
  </div>
</template>
