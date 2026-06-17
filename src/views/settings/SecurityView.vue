<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError, type TOTPEnrollResponse } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import CopyButton from "@/components/common/CopyButton.vue";
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
import { Badge } from "@/components/ui/badge";

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const passwordPending = ref(false);
const passwordError = ref<string | undefined>();

const enrollment = ref<TOTPEnrollResponse | undefined>();
const activationCode = ref("");
const disableCode = ref("");
const totpPending = ref<"enroll" | "activate" | "disable" | undefined>();
const totpError = ref<string | undefined>();

const totpEnabled = computed(() => !!auth.principal?.totp_enabled);
const recoveryText = computed(() => enrollment.value?.recovery_codes.join("\n") ?? "");
const isSuperuser = computed(() => (auth.principal?.scopes ?? []).includes("*"));
const principalScopes = computed(() => auth.principal?.scopes ?? []);

const passwordReady = computed(() => {
  const current = currentPassword.value.trim();
  const next = newPassword.value;
  return (
    current.length > 0 &&
    next.length >= 12 &&
    next === confirmPassword.value &&
    next !== currentPassword.value
  );
});

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return t("settings.security.requestFailed");
}

async function clearSessionAndLogin() {
  try {
    await auth.logout();
  } catch {
    // Password and 2FA changes intentionally invalidate the current session.
  }
  await router.push({ name: "login" });
}

function validatePasswordForm(): string | undefined {
  if (!currentPassword.value.trim()) return t("settings.security.password.currentRequired");
  if (newPassword.value.length < 12) return t("settings.security.password.tooShort");
  if (newPassword.value !== confirmPassword.value) return t("settings.security.password.mismatch");
  if (newPassword.value === currentPassword.value) return t("settings.security.password.reuse");
  return undefined;
}

async function submitPassword() {
  const validation = validatePasswordForm();
  if (validation) {
    passwordError.value = validation;
    return;
  }

  passwordPending.value = true;
  passwordError.value = undefined;
  try {
    await api.auth.changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    toast.success(t("settings.security.password.changed"));
    await clearSessionAndLogin();
  } catch (error) {
    passwordError.value = toMessage(error);
    toast.error(t("settings.security.password.changeFailed"));
  } finally {
    passwordPending.value = false;
  }
}

async function startEnrollment() {
  totpPending.value = "enroll";
  totpError.value = undefined;
  try {
    enrollment.value = await api.auth.totpEnroll();
    activationCode.value = "";
    toast.success(t("settings.security.totp.enrollmentStarted"));
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error(t("settings.security.totp.enrollmentFailed"));
  } finally {
    totpPending.value = undefined;
  }
}

async function activateTotp() {
  const code = activationCode.value.trim();
  if (!code) {
    totpError.value = t("settings.security.totp.enterAuthenticatorCode");
    return;
  }

  totpPending.value = "activate";
  totpError.value = undefined;
  try {
    await api.auth.totpActivate(code);
    enrollment.value = undefined;
    activationCode.value = "";
    await auth.bootstrap();
    toast.success(t("settings.security.totp.enabled"));
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error(t("settings.security.totp.activationFailed"));
  } finally {
    totpPending.value = undefined;
  }
}

async function disableTotp() {
  const code = disableCode.value.trim();
  if (!code) {
    totpError.value = t("settings.security.totp.enterDisableCode");
    return;
  }

  totpPending.value = "disable";
  totpError.value = undefined;
  try {
    await api.auth.totpDisable(code);
    disableCode.value = "";
    toast.success(t("settings.security.totp.disabled"));
    await clearSessionAndLogin();
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error(t("settings.security.totp.disableFailed"));
  } finally {
    totpPending.value = undefined;
  }
}

function cancelEnrollment() {
  enrollment.value = undefined;
  activationCode.value = "";
  totpError.value = undefined;
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('settings.security.title')"
      :description="$t('settings.security.description')"
    >
      <template #actions>
        <Badge :variant="totpEnabled ? 'success' : 'secondary'" class="gap-1.5">
          <CheckCircle2 v-if="totpEnabled" class="size-3.5" aria-hidden="true" />
          <AlertTriangle v-else class="size-3.5" aria-hidden="true" />
          {{ totpEnabled ? $t("settings.security.badgeEnabled") : $t("settings.security.badgeOff") }}
        </Badge>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t("settings.security.password.title") }}
          </CardTitle>
          <CardDescription>
            {{ $t("settings.security.password.description") }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form class="grid max-w-xl gap-4" @submit.prevent="submitPassword">
            <div class="grid gap-2">
              <Label for="current-password">{{ $t("settings.security.password.current") }}</Label>
              <Input
                id="current-password"
                v-model="currentPassword"
                type="password"
                autocomplete="current-password"
                :aria-invalid="!!passwordError"
              />
            </div>

            <div class="grid gap-2">
              <Label for="new-password">{{ $t("settings.security.password.new") }}</Label>
              <Input
                id="new-password"
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                :aria-invalid="!!passwordError"
              />
              <p class="text-xs text-muted-foreground">
                {{ $t("settings.security.password.newHint") }}
              </p>
            </div>

            <div class="grid gap-2">
              <Label for="confirm-password">{{ $t("settings.security.password.confirm") }}</Label>
              <Input
                id="confirm-password"
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                :aria-invalid="!!passwordError"
              />
            </div>

            <p
              v-if="passwordError"
              class="flex items-center gap-2 text-sm text-destructive"
            >
              <AlertTriangle class="size-4" aria-hidden="true" />
              {{ passwordError }}
            </p>

            <div class="flex flex-wrap items-center gap-3 pt-1">
              <Button
                type="submit"
                :disabled="passwordPending || !passwordReady"
              >
                <RefreshCw
                  v-if="passwordPending"
                  class="size-4 animate-spin"
                  aria-hidden="true"
                />
                <LockKeyhole v-else class="size-4" aria-hidden="true" />
                {{ $t("settings.security.password.submit") }}
              </Button>
              <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <LogOut class="size-3.5" aria-hidden="true" />
                {{ $t("settings.security.password.redirectHint") }}
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t("settings.security.session.title") }}
          </CardTitle>
          <CardDescription>
            {{ $t("settings.security.session.description") }}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4 text-sm">
          <div class="grid gap-1">
            <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t("settings.security.session.username") }}</span>
            <span class="break-all font-mono text-xs">
              {{ auth.principal?.username || $t("settings.security.session.unknown") }}
            </span>
          </div>
          <div class="grid gap-1">
            <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t("settings.security.session.actor") }}</span>
            <span class="break-all font-mono text-xs">
              {{ auth.principal?.actor_id || $t("settings.security.session.unknown") }}
            </span>
          </div>
          <div class="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            {{ isSuperuser ? $t("settings.security.session.superuserHelp") : $t("settings.security.session.scopedHelp") }}
          </div>
          <div class="grid gap-2">
            <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t("settings.security.session.scopes") }}</span>
            <div class="flex flex-wrap gap-1.5">
              <Badge
                v-for="scope in principalScopes"
                :key="scope"
                variant="outline"
                class="font-mono"
              >
                {{ scope }}
              </Badge>
              <Badge v-if="principalScopes.length === 0" variant="secondary">
                {{ $t("settings.security.session.noScopes") }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Smartphone class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t("settings.security.totp.title") }}
        </CardTitle>
        <CardDescription>
          {{ $t("settings.security.totp.description") }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <div
          class="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="space-y-1">
            <p class="text-sm font-medium">
              {{ $t("settings.security.totp.status") }}
            </p>
            <p class="text-sm text-muted-foreground">
              {{ totpEnabled ? $t("settings.security.totp.requiredAfterSignIn") : $t("settings.security.totp.passwordOnlyActive") }}
            </p>
          </div>
          <Badge :variant="totpEnabled ? 'success' : 'secondary'" class="w-fit">
            {{ totpEnabled ? $t("common.status.enabled") : $t("common.status.disabled") }}
          </Badge>
        </div>

        <p
          v-if="totpError"
          class="flex items-center gap-2 text-sm text-destructive"
        >
          <AlertTriangle class="size-4" aria-hidden="true" />
          {{ totpError }}
        </p>

        <div v-if="!totpEnabled" class="space-y-5">
          <div v-if="!enrollment" class="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              :disabled="totpPending === 'enroll'"
              @click="startEnrollment"
            >
              <RefreshCw
                v-if="totpPending === 'enroll'"
                class="size-4 animate-spin"
                aria-hidden="true"
              />
              <ShieldCheck v-else class="size-4" aria-hidden="true" />
              {{ $t("settings.security.totp.startEnrollment") }}
            </Button>
            <span class="text-xs text-muted-foreground">
              {{ $t("settings.security.totp.startEnrollmentHint") }}
            </span>
          </div>

          <div v-else class="space-y-5">
            <div class="grid gap-4 lg:grid-cols-2">
              <div class="space-y-2 rounded-md border border-border p-4">
                <div class="flex items-center justify-between gap-3">
                  <Label>{{ $t("settings.security.totp.setupKey") }}</Label>
                  <CopyButton :value="enrollment.secret" />
                </div>
                <code class="block break-all font-mono text-xs text-foreground">
                  {{ enrollment.secret }}
                </code>
              </div>

              <div class="space-y-2 rounded-md border border-border p-4">
                <div class="flex items-center justify-between gap-3">
                  <Label>{{ $t("settings.security.totp.provisioningUri") }}</Label>
                  <CopyButton :value="enrollment.otpauth_uri" />
                </div>
                <code class="line-clamp-3 block break-all font-mono text-xs text-muted-foreground">
                  {{ enrollment.otpauth_uri }}
                </code>
              </div>
            </div>

            <div class="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium text-warning-foreground">
                    {{ $t("settings.security.totp.recoveryCodes") }}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    {{ $t("settings.security.totp.recoveryCodesHint") }}
                  </p>
                </div>
                <CopyButton
                  v-if="recoveryText"
                  :value="recoveryText"
                  :label="$t('settings.security.totp.copyAll')"
                />
              </div>
              <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <code
                  v-for="code in enrollment.recovery_codes"
                  :key="code"
                  class="rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-xs"
                >
                  {{ code }}
                </code>
              </div>
            </div>

            <form class="flex flex-col gap-3 sm:flex-row sm:items-end" @submit.prevent="activateTotp">
              <div class="grid min-w-0 flex-1 gap-2">
                <Label for="totp-activate-code">{{ $t("settings.security.totp.activateCode") }}</Label>
                <Input
                  id="totp-activate-code"
                  v-model="activationCode"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="123456"
                />
              </div>
              <div class="flex gap-2">
                <Button
                  type="submit"
                  :disabled="totpPending === 'activate'"
                >
                  <RefreshCw
                    v-if="totpPending === 'activate'"
                    :class="cn('size-4 animate-spin')"
                    aria-hidden="true"
                  />
                  <CheckCircle2 v-else class="size-4" aria-hidden="true" />
                  {{ $t("settings.security.totp.activate") }}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="totpPending === 'activate'"
                  @click="cancelEnrollment"
                >
                  {{ $t("common.actions.cancel") }}
                </Button>
              </div>
            </form>
          </div>
        </div>

        <form
          v-else
          class="flex flex-col gap-3 sm:flex-row sm:items-end"
          @submit.prevent="disableTotp"
        >
          <div class="grid min-w-0 flex-1 gap-2">
            <Label for="totp-disable-code">{{ $t("settings.security.totp.disableCode") }}</Label>
            <Input
              id="totp-disable-code"
              v-model="disableCode"
              autocomplete="one-time-code"
              :placeholder="$t('settings.security.totp.disableCodePlaceholder')"
            />
          </div>
          <Button
            type="submit"
            variant="destructive"
            :disabled="totpPending === 'disable'"
          >
            <RefreshCw
              v-if="totpPending === 'disable'"
              class="size-4 animate-spin"
              aria-hidden="true"
            />
            <AlertTriangle v-else class="size-4" aria-hidden="true" />
            {{ $t("settings.security.totp.disable") }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
