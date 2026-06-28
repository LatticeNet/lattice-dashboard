<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  CircleCheck,
  CircleX,
  DownloadCloud,
  Info,
  PlugZap,
  Store,
} from "lucide-vue-next";
import {
  api,
  type SubStoreImportResponse,
  type SubStoreStatusResponse,
} from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const auth = useAuthStore();
const { t } = useI18n();

const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("proxy.substore.adminReason"));

// The Sub-Store backend URL lives only in this browser — there is no server-side
// config for it yet. It includes the operator's secret path, so we deliberately
// keep it client-local rather than persisting it through the API.
const STORAGE_KEY = "lattice:substore:base-url";
const baseUrl = ref<string>(readStored());

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

const userId = ref<string>("");

const checking = ref(false);
const status = ref<SubStoreStatusResponse | undefined>();
const importing = ref(false);
const result = ref<SubStoreImportResponse | undefined>();
const importError = ref<string | undefined>();

// Persist the base URL as it changes; a changed backend invalidates the previous
// reachability probe and import result, so clear those too.
watch(baseUrl, (next) => {
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — keep working in-memory */
  }
  status.value = undefined;
  result.value = undefined;
  importError.value = undefined;
});

const trimmedBaseUrl = computed(() => baseUrl.value.trim());
const hasBaseUrl = computed(() => trimmedBaseUrl.value.length > 0);

async function check() {
  if (!hasBaseUrl.value) {
    toast.error(t("proxy.substore.errorBaseUrlRequired"));
    return;
  }
  if (checking.value) return;
  checking.value = true;
  try {
    status.value = await api.substore.status(trimmedBaseUrl.value);
    if (status.value.reachable) toast.success(t("proxy.substore.toastChecked"));
    else toast.error(t("proxy.substore.toastCheckFailed"));
  } catch (error) {
    status.value = { reachable: false, sub_name: "" };
    toast.error(error instanceof Error ? error.message : t("proxy.substore.toastCheckFailed"));
  } finally {
    checking.value = false;
  }
}

async function runImport() {
  if (!canAdmin.value) return;
  if (!hasBaseUrl.value) {
    toast.error(t("proxy.substore.errorBaseUrlRequired"));
    return;
  }
  if (importing.value) return;
  importing.value = true;
  importError.value = undefined;
  try {
    const trimmedUser = userId.value.trim();
    result.value = await api.substore.import({
      base_url: trimmedBaseUrl.value,
      user_id: trimmedUser || undefined,
    });
    toast.success(
      t("proxy.substore.toastImported", {
        pushed: result.value.pushed,
        name: result.value.sub_name,
      }),
    );
  } catch (error) {
    result.value = undefined;
    importError.value = error instanceof Error ? error.message : t("proxy.substore.toastImportFailed");
    toast.error(importError.value);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.substore.title')"
      :description="$t('proxy.substore.description')"
    >
      <template #status>
        <Badge v-if="status?.reachable" variant="success" class="gap-1">
          <CircleCheck class="size-3" aria-hidden="true" />
          {{ $t('proxy.substore.statusReachable') }}
        </Badge>
        <Badge v-else-if="status" variant="destructive" class="gap-1">
          <CircleX class="size-3" aria-hidden="true" />
          {{ $t('proxy.substore.statusUnreachable') }}
        </Badge>
        <Badge v-else variant="secondary">{{ $t('proxy.substore.statusUnknown') }}</Badge>
      </template>
    </PageHeader>

    <!-- Internal-only explainer -->
    <div class="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
      <Info class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div class="space-y-1">
        <p class="font-medium text-foreground">{{ $t('proxy.substore.noteTitle') }}</p>
        <p class="text-muted-foreground">{{ $t('proxy.substore.noteBody') }}</p>
      </div>
    </div>

    <!-- Backend connection -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Store class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('proxy.substore.backendTitle') }}
        </CardTitle>
        <CardDescription>{{ $t('proxy.substore.backendDescription') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-1.5">
          <Label for="substore-base-url">{{ $t('proxy.substore.fieldBaseUrl') }}</Label>
          <div class="flex flex-col gap-2 sm:flex-row">
            <Input
              id="substore-base-url"
              v-model="baseUrl"
              type="url"
              autocomplete="off"
              spellcheck="false"
              class="font-mono sm:flex-1"
              :placeholder="$t('proxy.substore.fieldBaseUrlPlaceholder')"
              @keyup.enter="check"
            />
            <Button
              variant="outline"
              class="shrink-0"
              :disabled="!hasBaseUrl || checking"
              @click="check"
            >
              <PlugZap :class="cn('size-4', checking && 'animate-pulse')" aria-hidden="true" />
              {{ checking ? $t('proxy.substore.checking') : $t('proxy.substore.check') }}
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('proxy.substore.baseUrlHint') }}</p>
        </div>

        <div v-if="status" class="flex flex-wrap items-center gap-2 text-sm">
          <Badge v-if="status.reachable" variant="success" class="gap-1">
            <CircleCheck class="size-3" aria-hidden="true" />
            {{ $t('proxy.substore.statusReachable') }}
          </Badge>
          <Badge v-else variant="destructive" class="gap-1">
            <CircleX class="size-3" aria-hidden="true" />
            {{ $t('proxy.substore.statusUnreachable') }}
          </Badge>
          <span v-if="status.sub_name" class="text-muted-foreground">
            {{ $t('proxy.substore.managedSub') }}:
            <code class="font-mono text-foreground">{{ status.sub_name }}</code>
          </span>
        </div>
      </CardContent>
    </Card>

    <!-- Import -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <DownloadCloud class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('proxy.substore.importTitle') }}
        </CardTitle>
        <CardDescription>{{ $t('proxy.substore.importDescription') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-1.5">
          <Label for="substore-user-id">{{ $t('proxy.substore.fieldUserId') }}</Label>
          <Input
            id="substore-user-id"
            v-model="userId"
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            :placeholder="$t('proxy.substore.fieldUserIdPlaceholder')"
          />
          <p class="text-xs text-muted-foreground">{{ $t('proxy.substore.userIdHint') }}</p>
        </div>

        <div class="flex items-center gap-3">
          <Button
            :disabled="!canAdmin || !hasBaseUrl || importing"
            :title="canAdmin ? undefined : adminReason"
            @click="runImport"
          >
            <DownloadCloud :class="cn('size-4', importing && 'animate-pulse')" aria-hidden="true" />
            {{ importing ? $t('proxy.substore.importing') : $t('proxy.substore.importNow') }}
          </Button>
          <span v-if="!canAdmin" class="text-xs text-muted-foreground">{{ adminReason }}</span>
        </div>

        <div
          v-if="result"
          class="flex items-start gap-3 rounded-md border border-success/40 bg-success/5 p-3 text-sm"
        >
          <CircleCheck class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <div class="space-y-0.5">
            <p class="font-medium text-foreground">{{ $t('proxy.substore.resultTitle') }}</p>
            <p class="text-muted-foreground">
              {{ $t('proxy.substore.resultPushed', { pushed: result.pushed }, result.pushed) }}
              <code class="font-mono text-foreground">{{ $t('proxy.substore.resultSub', { name: result.sub_name }) }}</code>
            </p>
          </div>
        </div>

        <div
          v-else-if="importError"
          class="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <CircleX class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <p class="break-words text-destructive">{{ importError }}</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
