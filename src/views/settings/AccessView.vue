<script setup lang="ts">
/**
 * Access (design 23, section 4.6): who can sign in and with what.
 *
 * Users, Access Tokens and SSO were three Settings pages holding zero to two
 * rows each; they are one page with a layer per kind on `?view=`, each
 * offered only to an operator with its scope. The old addresses redirect
 * here with their layer named. None of the layers polls: the data changes
 * only when an operator changes it (design 23, section 3.10). Security and
 * 2FA stays its own page, because the MFA guard redirects there.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { api, unwrap } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useAsyncData } from "@/composables/useAsyncData";
import { useLayer } from "@/composables/useLayer";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import PageHeader from "@/components/common/PageHeader.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import UsersView from "./UsersView.vue";
import TokensView from "./TokensView.vue";
import SsoView from "./SsoView.vue";

type Layer = "users" | "tokens" | "sso";

const { t } = useI18n();
const auth = useAuthStore();

const LAYER_SCOPE: Record<Layer, string> = { users: "user:admin", tokens: "token:admin", sso: "oidc:admin" };
const allowed = computed<Layer[]>(() => (["users", "tokens", "sso"] as const).filter((layer) => auth.can(LAYER_SCOPE[layer])));
const layer = useLayer<Layer>(() => allowed.value, () => allowed.value[0] ?? "users");

const tabs = computed<LayerTab<Layer>[]>(() => allowed.value.map((value) => ({ value, label: t(`settings.access.layers.${value}`) })));

/*
 * Users and tokens can be confined to nodes, stored by id. Read the fleet
 * once, without polling, so those cells name the nodes (design 23, section
 * 3.10); without node:read they show the shortened id.
 */
const canReadNodes = computed(() => auth.can("node:read"));
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  immediate: canReadNodes.value,
});
provideNodeDirectory(computed(() => nodesQuery.data.value));
</script>

<template>
  <div class="page-narrow space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('settings.access.title')" :description="$t('settings.access.description')" />
    <LayerTabs v-if="tabs.length > 1" v-model="layer" :tabs="tabs" :label="$t('settings.access.layersLabel')" />
    <UsersView v-if="layer === 'users' && allowed.includes('users')" />
    <TokensView v-else-if="layer === 'tokens' && allowed.includes('tokens')" />
    <SsoView v-else-if="layer === 'sso' && allowed.includes('sso')" />
    <p v-else class="text-sm text-muted-foreground">{{ $t('settings.access.noScope') }}</p>
  </div>
</template>
