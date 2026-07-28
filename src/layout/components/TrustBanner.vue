<script setup lang="ts">
import { ShieldAlert } from "lucide-vue-next";

import { OFFICIAL_PUBLISHER } from "@/layout/trustBannerModel";
import { usePluginTrust } from "@/composables/usePluginTrust";

// Not dismissible by design (TASK-0012): a marker an operator can clear for the
// session is a marker that is absent in the screenshot that matters.
const { state } = usePluginTrust();
</script>

<template>
  <div
    v-if="state.visible"
    role="status"
    data-testid="trust-banner"
    class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-100"
  >
    <ShieldAlert class="size-4 shrink-0" aria-hidden="true" />
    <span class="font-semibold">{{ $t("trust.banner.label") }}</span>
    <span v-if="state.publishers.length">
      {{ $t("trust.banner.publishers", { official: OFFICIAL_PUBLISHER, names: state.publishers.join(", ") }) }}
    </span>
    <span v-if="state.unsignedHostRisk" class="font-semibold">
      {{ $t("trust.banner.unsigned") }}
    </span>
    <span class="opacity-90">{{ $t("trust.banner.detail") }}</span>
  </div>
</template>
