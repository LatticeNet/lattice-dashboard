// usePluginTrust — reads the server's trust posture once per session so the
// console can announce a non-official publisher (TASK-0012).
//
// Deliberately quiet on failure: an older server has no such endpoint, and a
// warning invented from a 404 would teach operators to ignore the banner. The
// fail-closed half lives on the server, which always emits the object.

import { onMounted, ref } from "vue";

import { api } from "@/lib/api";
import { trustBannerState, type TrustBannerState } from "@/layout/trustBannerModel";

const HIDDEN: TrustBannerState = { visible: false, publishers: [], unsignedHostRisk: false };

export function usePluginTrust() {
  const state = ref<TrustBannerState>(HIDDEN);

  async function load(): Promise<void> {
    try {
      state.value = trustBannerState(await api.plugins.trust());
    } catch {
      state.value = HIDDEN;
    }
  }

  onMounted(() => {
    void load();
  });

  return { state, load };
}
