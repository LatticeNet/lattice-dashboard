<script setup lang="ts">
import { computed, ref } from "vue";
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
  return "Request failed";
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
  if (!currentPassword.value.trim()) return "Current password is required.";
  if (newPassword.value.length < 12) return "New password must be at least 12 characters.";
  if (newPassword.value !== confirmPassword.value) return "New passwords do not match.";
  if (newPassword.value === currentPassword.value) return "Use a different new password.";
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
    toast.success("Password changed");
    await clearSessionAndLogin();
  } catch (error) {
    passwordError.value = toMessage(error);
    toast.error("Password change failed");
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
    toast.success("2FA enrollment started");
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error("2FA enrollment failed");
  } finally {
    totpPending.value = undefined;
  }
}

async function activateTotp() {
  const code = activationCode.value.trim();
  if (!code) {
    totpError.value = "Enter the code from your authenticator app.";
    return;
  }

  totpPending.value = "activate";
  totpError.value = undefined;
  try {
    await api.auth.totpActivate(code);
    enrollment.value = undefined;
    activationCode.value = "";
    await auth.bootstrap();
    toast.success("2FA enabled");
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error("2FA activation failed");
  } finally {
    totpPending.value = undefined;
  }
}

async function disableTotp() {
  const code = disableCode.value.trim();
  if (!code) {
    totpError.value = "Enter a TOTP code or recovery code.";
    return;
  }

  totpPending.value = "disable";
  totpError.value = undefined;
  try {
    await api.auth.totpDisable(code);
    disableCode.value = "";
    toast.success("2FA disabled");
    await clearSessionAndLogin();
  } catch (error) {
    totpError.value = toMessage(error);
    toast.error("2FA disable failed");
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
      title="Security & 2FA"
      description="Password rotation and second-factor controls for this admin session"
    >
      <template #actions>
        <Badge :variant="totpEnabled ? 'success' : 'secondary'" class="gap-1.5">
          <CheckCircle2 v-if="totpEnabled" class="size-3.5" />
          <AlertTriangle v-else class="size-3.5" />
          2FA {{ totpEnabled ? "enabled" : "off" }}
        </Badge>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <KeyRound class="size-4 text-muted-foreground" />
            Password
          </CardTitle>
          <CardDescription>
            Change the admin password. All existing sessions must sign in again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form class="grid max-w-xl gap-4" @submit.prevent="submitPassword">
            <div class="grid gap-2">
              <Label for="current-password">Current password</Label>
              <Input
                id="current-password"
                v-model="currentPassword"
                type="password"
                autocomplete="current-password"
                :aria-invalid="!!passwordError"
              />
            </div>

            <div class="grid gap-2">
              <Label for="new-password">New password</Label>
              <Input
                id="new-password"
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                :aria-invalid="!!passwordError"
              />
              <p class="text-xs text-muted-foreground">
                Use at least 12 characters.
              </p>
            </div>

            <div class="grid gap-2">
              <Label for="confirm-password">Confirm new password</Label>
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
              <AlertTriangle class="size-4" />
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
                />
                <LockKeyhole v-else class="size-4" />
                Change password
              </Button>
              <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <LogOut class="size-3.5" />
                Redirects to login after success
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <ShieldCheck class="size-4 text-muted-foreground" />
            Session
          </CardTitle>
          <CardDescription>
            Current authenticated principal
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4 text-sm">
          <div class="grid gap-1">
            <span class="text-xs font-medium uppercase text-muted-foreground">Actor</span>
            <span class="break-all font-mono text-xs">
              {{ auth.principal?.actor_id || "unknown" }}
            </span>
          </div>
          <div class="grid gap-2">
            <span class="text-xs font-medium uppercase text-muted-foreground">Scopes</span>
            <div class="flex flex-wrap gap-1.5">
              <Badge
                v-for="scope in (auth.principal?.scopes ?? []).slice(0, 10)"
                :key="scope"
                variant="outline"
                class="font-mono"
              >
                {{ scope }}
              </Badge>
              <Badge
                v-if="(auth.principal?.scopes ?? []).length > 10"
                variant="secondary"
              >
                +{{ (auth.principal?.scopes ?? []).length - 10 }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Smartphone class="size-4 text-muted-foreground" />
          Authenticator App
        </CardTitle>
        <CardDescription>
          TOTP enrollment, activation, recovery, and disable controls
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <div
          class="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="space-y-1">
            <p class="text-sm font-medium">
              Status
            </p>
            <p class="text-sm text-muted-foreground">
              {{ totpEnabled ? "A second factor is required after password sign-in." : "Password-only sign-in is active." }}
            </p>
          </div>
          <Badge :variant="totpEnabled ? 'success' : 'secondary'" class="w-fit">
            {{ totpEnabled ? "Enabled" : "Disabled" }}
          </Badge>
        </div>

        <p
          v-if="totpError"
          class="flex items-center gap-2 text-sm text-destructive"
        >
          <AlertTriangle class="size-4" />
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
              />
              <ShieldCheck v-else class="size-4" />
              Start enrollment
            </Button>
            <span class="text-xs text-muted-foreground">
              Creates a setup key and one-time recovery codes.
            </span>
          </div>

          <div v-else class="space-y-5">
            <div class="grid gap-4 lg:grid-cols-2">
              <div class="space-y-2 rounded-md border border-border p-4">
                <div class="flex items-center justify-between gap-3">
                  <Label>Setup key</Label>
                  <CopyButton :value="enrollment.secret" />
                </div>
                <code class="block break-all font-mono text-xs text-foreground">
                  {{ enrollment.secret }}
                </code>
              </div>

              <div class="space-y-2 rounded-md border border-border p-4">
                <div class="flex items-center justify-between gap-3">
                  <Label>Provisioning URI</Label>
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
                    Recovery codes
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Save these now. They are shown once.
                  </p>
                </div>
                <CopyButton
                  v-if="recoveryText"
                  :value="recoveryText"
                  label="Copy all"
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
                <Label for="totp-activate-code">Authenticator code</Label>
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
                  />
                  <CheckCircle2 v-else class="size-4" />
                  Activate
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="totpPending === 'activate'"
                  @click="cancelEnrollment"
                >
                  Cancel
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
            <Label for="totp-disable-code">TOTP or recovery code</Label>
            <Input
              id="totp-disable-code"
              v-model="disableCode"
              autocomplete="one-time-code"
              placeholder="123456 or recovery code"
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
            />
            <AlertTriangle v-else class="size-4" />
            Disable 2FA
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
