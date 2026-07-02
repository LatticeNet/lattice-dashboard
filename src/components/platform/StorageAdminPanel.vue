<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Database,
  FolderOpen,
  Globe2,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  type StorageAccess,
  type StorageBinding,
  type StorageKind,
  type StorageTokenCreateResponse,
  type StorageTokenView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import CopyButton from "@/components/common/CopyButton.vue";
import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const props = defineProps<{
  kind: StorageKind;
  activeBucket?: string;
}>();

const { t } = useI18n();
const auth = useAuthStore();

const canRead = computed(() => auth.can(`${props.kind}:read`));
const canAdmin = computed(() => auth.can(`${props.kind}:admin`));
const isStatic = computed(() => props.kind === "static");
const scopeRead = computed(() => `${props.kind}:read`);
const scopeAdmin = computed(() => `${props.kind}:admin`);
const currentBucket = computed(() => props.activeBucket?.trim() || "default");

const bucketsQuery = useAsyncData(
  () => {
    if (!canRead.value) return Promise.resolve({ buckets: [] });
    return api.storage.buckets(props.kind);
  },
  {
    pollInterval: 15000,
    immediate: canRead.value,
  },
);
const bindingsQuery = useAsyncData(
  () => {
    if (!canRead.value || !canAdmin.value) return Promise.resolve({ bindings: [] });
    return api.storage.bindings(props.kind);
  },
  {
    pollInterval: 15000,
    immediate: canRead.value && canAdmin.value,
  },
);
const tokensQuery = useAsyncData(
  () => {
    if (!canAdmin.value) return Promise.resolve({ tokens: [] });
    return api.storage.tokens(props.kind);
  },
  {
    pollInterval: 15000,
    immediate: canAdmin.value,
  },
);

const buckets = computed(() =>
  [...(bucketsQuery.data.value?.buckets ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
);
const bindings = computed(() =>
  [...(bindingsQuery.data.value?.bindings ?? [])].sort((a, b) =>
    a.hostname.localeCompare(b.hostname),
  ),
);
const tokens = computed(() =>
  [...(tokensQuery.data.value?.tokens ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
);

function refreshAdminData() {
  if (canRead.value) bucketsQuery.refresh();
  if (canAdmin.value) {
    if (canRead.value) bindingsQuery.refresh();
    tokensQuery.refresh();
  }
}

const bucketName = ref(currentBucket.value);
const bucketDisplayName = ref("");
const bucketDescription = ref("");
const bucketIndexDocument = ref("index.html");
const bucketNotFoundDocument = ref("404.html");
const bucketSaving = ref(false);

watch(currentBucket, (bucket) => {
  if (!bucketName.value || bucketName.value === "default") {
    bucketName.value = bucket;
  }
});

const canSubmitBucket = computed(() => canAdmin.value && !!bucketName.value.trim());

async function submitBucket() {
  if (!canSubmitBucket.value) return;
  bucketSaving.value = true;
  try {
    await api.storage.upsertBucket(props.kind, {
      name: bucketName.value.trim(),
      display_name: bucketDisplayName.value.trim() || undefined,
      description: bucketDescription.value.trim() || undefined,
      index_document: isStatic.value ? bucketIndexDocument.value.trim() || "index.html" : undefined,
      not_found_document: isStatic.value ? bucketNotFoundDocument.value.trim() || undefined : undefined,
    });
    toast.success(t("platform.storage.bucketSaved"));
    refreshAdminData();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.bucketSaveFailed"));
  } finally {
    bucketSaving.value = false;
  }
}

const bindingBucket = ref(currentBucket.value);
const bindingHostname = ref("");
const bindingPrefix = ref("");
const bindingEnabled = ref(true);
const bindingSaving = ref(false);
const deletingBindingId = ref("");

watch(currentBucket, (bucket) => {
  if (!bindingBucket.value || bindingBucket.value === "default") {
    bindingBucket.value = bucket;
  }
});

const canSubmitBinding = computed(
  () => canAdmin.value && !!bindingBucket.value.trim() && !!bindingHostname.value.trim(),
);

async function submitBinding() {
  if (!canSubmitBinding.value) return;
  bindingSaving.value = true;
  try {
    await api.storage.upsertBinding(props.kind, {
      bucket: bindingBucket.value.trim(),
      hostname: bindingHostname.value.trim(),
      path_prefix: bindingPrefix.value.trim() || undefined,
      enabled: bindingEnabled.value,
    });
    toast.success(t("platform.storage.bindingSaved"));
    bindingHostname.value = "";
    bindingPrefix.value = "";
    if (canRead.value) bindingsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.bindingSaveFailed"));
  } finally {
    bindingSaving.value = false;
  }
}

async function deleteBinding(binding: StorageBinding) {
  deletingBindingId.value = binding.id;
  try {
    await api.storage.deleteBinding(props.kind, binding.id);
    toast.success(t("platform.storage.bindingDeleted"));
    if (canRead.value) bindingsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.bindingDeleteFailed"));
  } finally {
    deletingBindingId.value = "";
  }
}

const tokenName = ref("");
const tokenAccess = ref<StorageAccess>("read");
const tokenBucketsText = ref(currentBucket.value);
const tokenSaving = ref(false);
const createdToken = ref<StorageTokenCreateResponse | undefined>();
const revokingTokenId = ref("");

watch(currentBucket, (bucket) => {
  if (!tokenBucketsText.value || tokenBucketsText.value === "default") {
    tokenBucketsText.value = bucket;
  }
});

function parseTokenBuckets(input: string): string[] {
  return input
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);
}

const parsedTokenBuckets = computed(() => parseTokenBuckets(tokenBucketsText.value));
const canSubmitToken = computed(
  () => canAdmin.value && !!tokenName.value.trim() && parsedTokenBuckets.value.length > 0,
);

async function submitToken() {
  if (!canSubmitToken.value) {
    if (canAdmin.value) toast.error(t("platform.storage.tokenBucketsRequired"));
    return;
  }
  tokenSaving.value = true;
  createdToken.value = undefined;
  try {
    createdToken.value = await api.storage.createToken(props.kind, {
      name: tokenName.value.trim(),
      access: tokenAccess.value,
      buckets: parsedTokenBuckets.value,
    });
    tokenName.value = "";
    toast.success(t("platform.storage.tokenCreated"));
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.tokenCreateFailed"));
  } finally {
    tokenSaving.value = false;
  }
}

async function revokeToken(token: StorageTokenView) {
  revokingTokenId.value = token.id;
  try {
    await api.storage.revokeToken(props.kind, token.id);
    toast.success(t("platform.storage.tokenRevoked"));
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.tokenRevokeFailed"));
  } finally {
    revokingTokenId.value = "";
  }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold tracking-normal">{{ $t('platform.storage.title') }}</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ isStatic ? $t('platform.storage.staticDescription') : $t('platform.storage.kvDescription') }}
        </p>
      </div>
      <Button
        v-if="canRead || canAdmin"
        variant="outline"
        size="sm"
        :disabled="bucketsQuery.refreshing.value || bindingsQuery.refreshing.value || tokensQuery.refreshing.value"
        @click="refreshAdminData"
      >
        <RefreshCw
          aria-hidden="true"
          :class="cn('size-4', (bucketsQuery.refreshing.value || bindingsQuery.refreshing.value || tokensQuery.refreshing.value) && 'animate-spin')"
        />
        {{ $t('common.actions.refresh') }}
      </Button>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Database v-if="!isStatic" aria-hidden="true" class="size-4 text-muted-foreground" />
          <FolderOpen v-else aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.storage.bucketsTitle') }}
        </CardTitle>
        <CardDescription>
          <span v-if="canAdmin">{{ $t('platform.storage.bucketsDescription') }}</span>
          <i18n-t v-else keypath="platform.storage.adminRequired" tag="span" scope="global">
            <template #scope><code class="font-mono">{{ scopeAdmin }}</code></template>
          </i18n-t>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form v-if="canAdmin" class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" @submit.prevent="submitBucket">
          <div class="grid gap-2">
            <Label :for="`${kind}-bucket-name`">{{ $t('platform.storage.bucketName') }}</Label>
            <Input :id="`${kind}-bucket-name`" v-model="bucketName" required placeholder="default" />
          </div>
          <div class="grid gap-2">
            <Label :for="`${kind}-bucket-label`">{{ $t('platform.storage.bucketDisplayName') }}</Label>
            <Input :id="`${kind}-bucket-label`" v-model="bucketDisplayName" :placeholder="$t('platform.storage.bucketDisplayPlaceholder')" />
          </div>
          <div class="flex items-end">
            <Button type="submit" class="w-full lg:w-auto" :disabled="!canSubmitBucket || bucketSaving">
              <RefreshCw v-if="bucketSaving" aria-hidden="true" class="size-4 animate-spin" />
              <Save v-else aria-hidden="true" class="size-4" />
              {{ $t('common.actions.save') }}
            </Button>
          </div>
          <div class="grid gap-2 lg:col-span-3">
            <Label :for="`${kind}-bucket-description`">{{ $t('platform.storage.bucketDescription') }}</Label>
            <Input :id="`${kind}-bucket-description`" v-model="bucketDescription" :placeholder="$t('platform.storage.bucketDescriptionPlaceholder')" />
          </div>
          <template v-if="isStatic">
            <div class="grid gap-2">
              <Label :for="`${kind}-index-document`">{{ $t('platform.storage.indexDocument') }}</Label>
              <Input :id="`${kind}-index-document`" v-model="bucketIndexDocument" placeholder="index.html" />
            </div>
            <div class="grid gap-2">
              <Label :for="`${kind}-not-found-document`">{{ $t('platform.storage.notFoundDocument') }}</Label>
              <Input :id="`${kind}-not-found-document`" v-model="bucketNotFoundDocument" placeholder="404.html" />
            </div>
          </template>
        </form>

        <DataState
          v-if="canRead"
          :loading="bucketsQuery.loading.value"
          :error="bucketsQuery.error.value"
          :is-empty="buckets.length === 0"
          :empty-title="$t('platform.storage.noBuckets')"
          :empty-description="$t('platform.storage.noBucketsDescription')"
          @retry="bucketsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colBucket') }}</th>
                  <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colDescription') }}</th>
                  <th v-if="isStatic" scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colDocuments') }}</th>
                  <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colUpdated') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="bucket in buckets" :key="bucket.id" class="border-b border-border last:border-b-0 align-top hover:bg-muted/40">
                  <td class="py-3 pr-3">
                    <p class="font-mono text-xs">{{ bucket.name }}</p>
                    <p v-if="bucket.display_name" class="mt-1 text-xs text-muted-foreground">{{ bucket.display_name }}</p>
                  </td>
                  <td class="py-3 pr-3 text-xs text-muted-foreground">{{ bucket.description || "-" }}</td>
                  <td v-if="isStatic" class="py-3 pr-3 font-mono text-xs text-muted-foreground">
                    {{ bucket.index_document || "index.html" }}
                    <span v-if="bucket.not_found_document"> / {{ bucket.not_found_document }}</span>
                  </td>
                  <td class="py-3 pr-3 text-xs text-muted-foreground">{{ formatDateTime(bucket.updated_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>
        <p v-else class="text-sm text-muted-foreground">
          <i18n-t keypath="platform.storage.readRequired" tag="span" scope="global">
            <template #scope><code class="font-mono">{{ scopeRead }}</code></template>
          </i18n-t>
        </p>
      </CardContent>
    </Card>

    <div v-if="canAdmin" class="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Globe2 aria-hidden="true" class="size-4 text-muted-foreground" />
            {{ $t('platform.storage.bindingsTitle') }}
          </CardTitle>
          <CardDescription>{{ $t('platform.storage.bindingsDescription') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="submitBinding">
            <div class="grid gap-2">
              <Label :for="`${kind}-binding-bucket`">{{ $t('platform.storage.bindingBucket') }}</Label>
              <Input :id="`${kind}-binding-bucket`" v-model="bindingBucket" required placeholder="default" />
            </div>
            <div class="grid gap-2">
              <Label :for="`${kind}-binding-host`">{{ $t('platform.storage.hostname') }}</Label>
              <Input :id="`${kind}-binding-host`" v-model="bindingHostname" required placeholder="assets.example.com" />
            </div>
            <div class="grid gap-2">
              <Label :for="`${kind}-binding-prefix`">{{ $t('platform.storage.pathPrefix') }}</Label>
              <Input :id="`${kind}-binding-prefix`" v-model="bindingPrefix" placeholder="public" />
            </div>
            <label class="flex items-end gap-2 pb-2 text-sm">
              <input v-model="bindingEnabled" type="checkbox" class="size-4 accent-primary" />
              <span>{{ $t('platform.storage.bindingEnabled') }}</span>
            </label>
            <div class="sm:col-span-2">
              <Button type="submit" :disabled="!canSubmitBinding || bindingSaving">
                <RefreshCw v-if="bindingSaving" aria-hidden="true" class="size-4 animate-spin" />
                <Plus v-else aria-hidden="true" class="size-4" />
                {{ $t('platform.storage.addBinding') }}
              </Button>
            </div>
          </form>

          <DataState
            v-if="canRead"
            :loading="bindingsQuery.loading.value"
            :error="bindingsQuery.error.value"
            :is-empty="bindings.length === 0"
            :empty-title="$t('platform.storage.noBindings')"
            :empty-description="$t('platform.storage.noBindingsDescription')"
            @retry="bindingsQuery.refresh"
          >
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colHost') }}</th>
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colBucket') }}</th>
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colStatus') }}</th>
                    <th scope="col" class="py-2 pl-3 text-right font-medium">{{ $t('platform.storage.colActions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="binding in bindings" :key="binding.id" class="border-b border-border last:border-b-0 align-top hover:bg-muted/40">
                    <td class="py-3 pr-3">
                      <p class="font-mono text-xs">{{ binding.hostname }}</p>
                      <p v-if="binding.path_prefix" class="mt-1 font-mono text-xs text-muted-foreground">/{{ binding.path_prefix }}</p>
                    </td>
                    <td class="py-3 pr-3 font-mono text-xs">{{ binding.bucket }}</td>
                    <td class="py-3 pr-3">
                      <Badge :variant="binding.enabled ? 'success' : 'secondary'">
                        {{ binding.enabled ? $t('platform.storage.enabled') : $t('platform.storage.disabled') }}
                      </Badge>
                    </td>
                    <td class="py-3 pl-3">
                      <div class="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="$t('platform.storage.deleteBinding')"
                          :disabled="deletingBindingId === binding.id"
                          @click="deleteBinding(binding)"
                        >
                          <RefreshCw v-if="deletingBindingId === binding.id" class="size-4 animate-spin" />
                          <Trash2 v-else class="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </DataState>
          <p v-else class="text-sm text-muted-foreground">
            <i18n-t keypath="platform.storage.readRequired" tag="span" scope="global">
              <template #scope><code class="font-mono">{{ scopeRead }}</code></template>
            </i18n-t>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <KeyRound aria-hidden="true" class="size-4 text-muted-foreground" />
            {{ $t('platform.storage.tokensTitle') }}
          </CardTitle>
          <CardDescription>{{ $t('platform.storage.tokensDescription') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="submitToken">
            <div class="grid gap-2">
              <Label :for="`${kind}-token-name`">{{ $t('platform.storage.tokenName') }}</Label>
              <Input :id="`${kind}-token-name`" v-model="tokenName" required placeholder="deploy-ci" />
            </div>
            <div class="grid gap-2">
              <Label :for="`${kind}-token-access`">{{ $t('platform.storage.tokenAccess') }}</Label>
              <Select v-model="tokenAccess">
                <SelectTrigger :id="`${kind}-token-access`" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{{ $t('platform.storage.accessRead') }}</SelectItem>
                  <SelectItem value="write">{{ $t('platform.storage.accessWrite') }}</SelectItem>
                  <SelectItem value="admin">{{ $t('platform.storage.accessAdmin') }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2 sm:col-span-2">
              <Label :for="`${kind}-token-buckets`">{{ $t('platform.storage.tokenBuckets') }}</Label>
              <Input :id="`${kind}-token-buckets`" v-model="tokenBucketsText" required placeholder="default, assets or *" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.storage.tokenBucketsHint') }}</p>
            </div>
            <div class="sm:col-span-2">
              <Button type="submit" :disabled="!canSubmitToken || tokenSaving">
                <RefreshCw v-if="tokenSaving" aria-hidden="true" class="size-4 animate-spin" />
                <ShieldCheck v-else aria-hidden="true" class="size-4" />
                {{ $t('platform.storage.createToken') }}
              </Button>
            </div>
          </form>

          <div v-if="createdToken" class="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-sm font-medium">{{ $t('platform.storage.tokenOneTimeTitle') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">{{ $t('platform.storage.tokenOneTimeDescription') }}</p>
              </div>
              <CopyButton :value="createdToken.token" :label="$t('common.actions.copy')" />
            </div>
            <code class="mt-3 block overflow-x-auto rounded-md bg-background p-2 text-xs">{{ createdToken.token }}</code>
          </div>

          <DataState
            :loading="tokensQuery.loading.value"
            :error="tokensQuery.error.value"
            :is-empty="tokens.length === 0"
            :empty-title="$t('platform.storage.noTokens')"
            :empty-description="$t('platform.storage.noTokensDescription')"
            @retry="tokensQuery.refresh"
          >
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colToken') }}</th>
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colAccess') }}</th>
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colBuckets') }}</th>
                    <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.storage.colLastUsed') }}</th>
                    <th scope="col" class="py-2 pl-3 text-right font-medium">{{ $t('platform.storage.colActions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="token in tokens" :key="token.id" class="border-b border-border last:border-b-0 align-top hover:bg-muted/40">
                    <td class="py-3 pr-3">
                      <p class="text-sm font-medium">{{ token.name }}</p>
                      <p class="font-mono text-xs text-muted-foreground">{{ token.id }}</p>
                    </td>
                    <td class="py-3 pr-3">
                      <Badge variant="outline">{{ token.access }}</Badge>
                      <Badge v-if="token.revoked_at" variant="destructive" class="ml-1">{{ $t('platform.storage.revoked') }}</Badge>
                    </td>
                    <td class="py-3 pr-3 font-mono text-xs">{{ token.buckets?.join(", ") || "-" }}</td>
                    <td class="py-3 pr-3 text-xs text-muted-foreground">
                      {{ token.last_used_at ? formatDateTime(token.last_used_at) : $t('platform.storage.neverUsed') }}
                    </td>
                    <td class="py-3 pl-3">
                      <div class="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="$t('platform.storage.revokeToken')"
                          :disabled="!!token.revoked_at || revokingTokenId === token.id"
                          @click="revokeToken(token)"
                        >
                          <RefreshCw v-if="revokingTokenId === token.id" class="size-4 animate-spin" />
                          <Trash2 v-else class="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </DataState>
        </CardContent>
      </Card>
    </div>
  </section>
</template>
