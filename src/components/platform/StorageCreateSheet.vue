<script setup lang="ts">
/**
 * Publishing's storage create forms, one at a time, in a sheet (design 23,
 * section 4.5): a bucket, a hostname bound to a bucket, or a storage token.
 * They were three always-open cards with three solid buttons above the lists
 * they fed; the page's one Publish menu now opens the one asked for.
 *
 * The kind (KV or Static) is chosen in the form, from the kinds the operator
 * administers. A created token is shown once, here, with a copy button; the
 * sheet stays open on it until the operator closes it.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Plus, RefreshCw, Save, ShieldCheck } from "lucide-vue-next";

import { api, type StorageAccess, type StorageKind, type StorageTokenCreateResponse } from "@/lib/api";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type StorageCreateMode = "bucket" | "binding" | "token";

const props = defineProps<{
  /** Which form is open, or null when the sheet is closed. */
  mode: StorageCreateMode | null;
  /** The kinds the operator administers; the first is preselected. */
  kinds: StorageKind[];
}>();

const emit = defineEmits<{ close: []; created: [kind: StorageKind, mode: StorageCreateMode] }>();

const { t } = useI18n();

const kind = ref<StorageKind>("kv");
const saving = ref(false);

const bucketName = ref("");
const bucketDisplayName = ref("");
const bucketDescription = ref("");
const bucketIndexDocument = ref("index.html");
const bucketNotFoundDocument = ref("404.html");

const bindingBucket = ref("");
const bindingHostname = ref("");
const bindingPrefix = ref("");
const bindingEnabled = ref(true);

const tokenName = ref("");
const tokenAccess = ref<StorageAccess>("read");
const tokenBucketsText = ref("");
const createdToken = ref<StorageTokenCreateResponse | undefined>();

/** A fresh form each time the sheet opens. */
watch(
  () => props.mode,
  (mode) => {
    if (!mode) return;
    kind.value = props.kinds[0] ?? "kv";
    bucketName.value = "";
    bucketDisplayName.value = "";
    bucketDescription.value = "";
    bucketIndexDocument.value = "index.html";
    bucketNotFoundDocument.value = "404.html";
    bindingBucket.value = "";
    bindingHostname.value = "";
    bindingPrefix.value = "";
    bindingEnabled.value = true;
    tokenName.value = "";
    tokenAccess.value = "read";
    tokenBucketsText.value = "";
    createdToken.value = undefined;
  },
  { immediate: true },
);

const isStatic = computed(() => kind.value === "static");
const tokenBuckets = computed(() =>
  tokenBucketsText.value
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean),
);

const canSubmit = computed(() => {
  switch (props.mode) {
    case "bucket":
      return !!bucketName.value.trim();
    case "binding":
      return !!bindingBucket.value.trim() && !!bindingHostname.value.trim();
    case "token":
      return !!tokenName.value.trim() && tokenBuckets.value.length > 0;
    default:
      return false;
  }
});

const title = computed(() => (props.mode ? t(`platform.publishingPage.create.${props.mode}Title`) : ""));

async function submit(): Promise<void> {
  if (!props.mode || !canSubmit.value || saving.value) return;
  const mode = props.mode;
  saving.value = true;
  try {
    if (mode === "bucket") {
      await api.storage.upsertBucket(kind.value, {
        name: bucketName.value.trim(),
        display_name: bucketDisplayName.value.trim() || undefined,
        description: bucketDescription.value.trim() || undefined,
        index_document: isStatic.value ? bucketIndexDocument.value.trim() || "index.html" : undefined,
        not_found_document: isStatic.value ? bucketNotFoundDocument.value.trim() || undefined : undefined,
      });
      toast.success(t("platform.storage.bucketSaved"));
      emit("created", kind.value, mode);
      emit("close");
    } else if (mode === "binding") {
      await api.storage.upsertBinding(kind.value, {
        bucket: bindingBucket.value.trim(),
        hostname: bindingHostname.value.trim(),
        path_prefix: bindingPrefix.value.trim() || undefined,
        enabled: bindingEnabled.value,
      });
      toast.success(t("platform.storage.bindingSaved"));
      emit("created", kind.value, mode);
      emit("close");
    } else {
      createdToken.value = await api.storage.createToken(kind.value, {
        name: tokenName.value.trim(),
        access: tokenAccess.value,
        buckets: tokenBuckets.value,
      });
      toast.success(t("platform.storage.tokenCreated"));
      emit("created", kind.value, mode);
    }
  } catch (error) {
    const fallback = {
      bucket: t("platform.storage.bucketSaveFailed"),
      binding: t("platform.storage.bindingSaveFailed"),
      token: t("platform.storage.tokenCreateFailed"),
    }[mode];
    toast.error(error instanceof Error ? error.message : fallback);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ObjectSheet :open="!!mode" :title="title" @close="emit('close')">
    <form v-if="mode" id="storage-create-form" class="space-y-4 text-sm" @submit.prevent="submit">
      <p class="text-muted-foreground">{{ $t(`platform.publishingPage.create.${mode}Description`) }}</p>

      <div class="grid gap-2">
        <Label for="storage-create-kind">{{ $t('platform.publishingPage.create.kind') }}</Label>
        <Select v-model="kind" :disabled="!!createdToken">
          <SelectTrigger id="storage-create-kind" class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in kinds" :key="option" :value="option">{{ $t(`platform.publishing.origin.${option}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <template v-if="mode === 'bucket'">
        <div class="grid gap-2">
          <Label for="storage-bucket-name">{{ $t('platform.storage.bucketName') }}</Label>
          <Input id="storage-bucket-name" v-model="bucketName" required placeholder="assets" />
        </div>
        <div class="grid gap-2">
          <Label for="storage-bucket-label">{{ $t('platform.storage.bucketDisplayName') }}</Label>
          <Input id="storage-bucket-label" v-model="bucketDisplayName" :placeholder="$t('platform.storage.bucketDisplayPlaceholder')" />
        </div>
        <div class="grid gap-2">
          <Label for="storage-bucket-description">{{ $t('platform.storage.bucketDescription') }}</Label>
          <Input id="storage-bucket-description" v-model="bucketDescription" :placeholder="$t('platform.storage.bucketDescriptionPlaceholder')" />
        </div>
        <div v-if="isStatic" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="grid gap-2">
            <Label for="storage-index-document">{{ $t('platform.storage.indexDocument') }}</Label>
            <Input id="storage-index-document" v-model="bucketIndexDocument" placeholder="index.html" />
          </div>
          <div class="grid gap-2">
            <Label for="storage-not-found-document">{{ $t('platform.storage.notFoundDocument') }}</Label>
            <Input id="storage-not-found-document" v-model="bucketNotFoundDocument" placeholder="404.html" />
          </div>
        </div>
      </template>

      <template v-else-if="mode === 'binding'">
        <div class="grid gap-2">
          <Label for="storage-binding-host">{{ $t('platform.storage.hostname') }}</Label>
          <Input id="storage-binding-host" v-model="bindingHostname" required placeholder="assets.example.com" />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="grid gap-2">
            <Label for="storage-binding-bucket">{{ $t('platform.storage.bindingBucket') }}</Label>
            <Input id="storage-binding-bucket" v-model="bindingBucket" required placeholder="default" />
          </div>
          <div class="grid gap-2">
            <Label for="storage-binding-prefix">{{ $t('platform.storage.pathPrefix') }}</Label>
            <Input id="storage-binding-prefix" v-model="bindingPrefix" placeholder="public" />
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="bindingEnabled" type="checkbox" class="size-4 accent-primary" />
          <span>{{ $t('platform.storage.bindingEnabled') }}</span>
        </label>
        <p class="text-xs text-muted-foreground">
          {{ isStatic ? $t('platform.publishingPage.create.bindingStatic') : $t('platform.publishingPage.create.bindingKv') }}
        </p>
      </template>

      <template v-else>
        <div class="grid gap-2">
          <Label for="storage-token-name">{{ $t('platform.storage.tokenName') }}</Label>
          <Input id="storage-token-name" v-model="tokenName" required placeholder="deploy-ci" :disabled="!!createdToken" />
        </div>
        <div class="grid gap-2">
          <Label for="storage-token-access">{{ $t('platform.storage.tokenAccess') }}</Label>
          <Select v-model="tokenAccess" :disabled="!!createdToken">
            <SelectTrigger id="storage-token-access" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{{ $t('platform.storage.accessRead') }}</SelectItem>
              <SelectItem value="write">{{ $t('platform.storage.accessWrite') }}</SelectItem>
              <SelectItem value="admin">{{ $t('platform.storage.accessAdmin') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-2">
          <Label for="storage-token-buckets">{{ $t('platform.storage.tokenBuckets') }}</Label>
          <Input id="storage-token-buckets" v-model="tokenBucketsText" required placeholder="default, assets or *" :disabled="!!createdToken" />
          <p class="text-xs text-muted-foreground">{{ $t('platform.storage.tokenBucketsHint') }}</p>
        </div>
        <div v-if="createdToken" class="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3" data-testid="created-token">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="font-medium">{{ $t('platform.storage.tokenOneTimeTitle') }}</p>
            <CopyButton :value="createdToken.token" :label="$t('common.actions.copy')" />
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('platform.storage.tokenOneTimeDescription') }}</p>
          <code class="block break-all rounded-md bg-background p-2 font-mono text-xs">{{ createdToken.token }}</code>
        </div>
      </template>
    </form>
    <template v-if="mode" #actions>
      <Button v-if="createdToken" type="button" variant="outline" size="sm" @click="emit('close')">{{ $t('common.actions.close') }}</Button>
      <Button v-else type="submit" form="storage-create-form" size="sm" :disabled="!canSubmit || saving">
        <RefreshCw v-if="saving" class="animate-spin" aria-hidden="true" />
        <Save v-else-if="mode === 'bucket'" aria-hidden="true" />
        <Plus v-else-if="mode === 'binding'" aria-hidden="true" />
        <ShieldCheck v-else aria-hidden="true" />
        {{ $t(`platform.publishingPage.create.${mode}Submit`) }}
      </Button>
    </template>
  </ObjectSheet>
</template>
