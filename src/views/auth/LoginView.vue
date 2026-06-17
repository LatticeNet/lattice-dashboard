<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  User,
  Lock,
  KeyRound,
  Loader2,
  ShieldCheck,
  CircleAlert,
  ArrowLeft,
  ArrowRight,
} from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { api, ApiError, type SSOProvider } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

type Step = "password" | "totp";
const step = ref<Step>("password");

const username = ref("admin");
const password = ref("");
const code = ref("");
const recovery = ref("");
const useRecovery = ref(false);

const pending = ref(false);
const errorMsg = ref<string | undefined>(undefined);
const errorRequestId = ref<string | undefined>(undefined);

const providers = ref<SSOProvider[]>([]);

const totpInput = ref<InstanceType<typeof Input> | null>(null);

const redirect = computed(() => {
  const r = route.query.redirect;
  return typeof r === "string" && r.startsWith("/") ? r : "/";
});

function setError(e: unknown) {
  if (e instanceof ApiError) {
    errorMsg.value = e.message;
    errorRequestId.value = e.requestId;
  } else if (e instanceof Error) {
    errorMsg.value = e.message;
    errorRequestId.value = undefined;
  } else {
    errorMsg.value = "Something went wrong. Please try again.";
    errorRequestId.value = undefined;
  }
}

function clearError() {
  errorMsg.value = undefined;
  errorRequestId.value = undefined;
}

function ssoErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    bad_request: "The identity provider returned an invalid login response.",
    csrf: "The SSO login could not be verified. Please start again.",
    denied: "This identity is not allowed to sign in to Lattice.",
    expired: "The SSO login expired. Please start again.",
    ip_mismatch: "The SSO login changed networks before it completed.",
    provider_error: "The identity provider cancelled or rejected the login.",
    session_failed: "Lattice could not create a session after SSO completed.",
    unavailable: "This identity provider is no longer available.",
    verify_failed: "Lattice could not verify the identity provider response.",
  };
  return messages[code] || "SSO login failed. Please try again.";
}

async function focusTotp() {
  await nextTick();
  const el = totpInput.value?.$el as HTMLInputElement | undefined;
  el?.focus?.();
}

async function onSubmitPassword() {
  if (pending.value) return;
  clearError();
  pending.value = true;
  try {
    const loggedIn = await auth.login(username.value, password.value);
    if (loggedIn) {
      router.push(redirect.value);
    } else {
      step.value = "totp";
      focusTotp();
    }
  } catch (e) {
    setError(e);
  } finally {
    pending.value = false;
  }
}

async function onSubmitTotp() {
  if (pending.value) return;
  clearError();
  pending.value = true;
  try {
    if (useRecovery.value) {
      await auth.completeTotp(undefined, recovery.value.trim());
    } else {
      await auth.completeTotp(code.value.trim());
    }
    router.push(redirect.value);
  } catch (e) {
    setError(e);
  } finally {
    pending.value = false;
  }
}

function backToPassword() {
  clearError();
  code.value = "";
  recovery.value = "";
  useRecovery.value = false;
  step.value = "password";
}

function startSso(id: string) {
  const returnToLogin = "/login?redirect=" + encodeURIComponent(redirect.value);
  const target =
    "/api/auth/oidc/start?provider=" +
    encodeURIComponent(id) +
    "&redirect=" +
    encodeURIComponent(returnToLogin);
  window.location.assign(target);
}

onMounted(async () => {
  // Surface SSO round-trip signals carried back in the URL, then clean it.
  const params = new URLSearchParams(window.location.search);
  const ssoError = params.get("sso_error");
  const challenge = params.get("totp_challenge");
  let mutated = false;

  if (ssoError) {
    errorMsg.value = ssoErrorMessage(ssoError);
    mutated = true;
  }
  if (challenge && /^[A-Za-z0-9_-]{32,128}$/.test(challenge)) {
    auth.pendingTotpChallenge = challenge;
    step.value = "totp";
    mutated = true;
    focusTotp();
  }
  if (mutated) {
    params.delete("sso_error");
    params.delete("totp_challenge");
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    history.replaceState(history.state, "", clean);
  }

  // Optional SSO providers — tolerate failure / empty silently.
  try {
    const list = await api.auth.ssoProviders();
    if (Array.isArray(list)) providers.value = list;
  } catch {
    /* SSO not configured — that's fine. */
  }
});
</script>

<template>
  <div class="relative min-h-screen w-full overflow-hidden bg-background lattice-grid">
    <!-- Decorative primary glow -->
    <div
      class="pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-primary/20 blur-3xl"
      aria-hidden="true"
    />
    <div
      class="pointer-events-none absolute -bottom-40 right-[-6rem] size-[26rem] rounded-full bg-primary/10 blur-3xl"
      aria-hidden="true"
    />

    <div class="relative grid min-h-screen lg:grid-cols-2">
      <!-- Hero -->
      <section class="hidden flex-col justify-between p-12 lg:flex">
        <div class="flex items-center gap-3">
          <span
            class="flex size-10 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-6"
              aria-hidden="true"
            >
              <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" />
              <path d="m12 2 0 20" />
              <path d="M21 7 12 12 3 7" />
              <path d="M21 17 12 12 3 17" />
            </svg>
          </span>
          <span class="text-xl font-semibold tracking-tight">Lattice</span>
        </div>

        <div class="max-w-md space-y-6">
          <h1 class="text-3xl font-semibold leading-tight tracking-tight">
            Self-hosted control plane for your fleet.
          </h1>
          <p class="text-sm text-muted-foreground">
            One pane of glass for every node — secure by default, auditable by design.
          </p>
          <ul class="space-y-3 text-sm">
            <li class="flex items-center gap-3 text-muted-foreground">
              <span class="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck class="size-4" aria-hidden="true" />
              </span>
              Secure by default
            </li>
            <li class="flex items-center gap-3 text-muted-foreground">
              <span class="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ArrowRight class="size-4" aria-hidden="true" />
              </span>
              Plan &rarr; approve &rarr; apply
            </li>
            <li class="flex items-center gap-3 text-muted-foreground">
              <span class="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <span class="size-2 rounded-full bg-success animate-pulse-dot" />
              </span>
              Real-time fleet
            </li>
          </ul>
        </div>

        <p class="text-xs text-muted-foreground">
          &copy; {{ new Date().getFullYear() }} Lattice
        </p>
      </section>

      <!-- Form -->
      <section class="flex items-center justify-center p-6">
        <div class="w-full max-w-sm">
          <!-- Compact brand for small screens -->
          <div class="mb-6 flex items-center gap-3 lg:hidden">
            <span
              class="flex size-9 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-5"
                aria-hidden="true"
              >
                <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" />
                <path d="m12 2 0 20" />
                <path d="M21 7 12 12 3 7" />
                <path d="M21 17 12 12 3 17" />
              </svg>
            </span>
            <span class="text-lg font-semibold tracking-tight">Lattice</span>
          </div>

          <div class="rounded-xl border border-border bg-card text-card-foreground shadow-sm">
            <div class="space-y-1.5 p-6 pb-4">
              <h2 class="text-2xl font-semibold tracking-tight">
                {{ step === "password" ? "Sign in" : "Two-factor authentication" }}
              </h2>
              <p class="text-sm text-muted-foreground">
                {{
                  step === "password"
                    ? "Enter your credentials to access the console."
                    : "Enter the 6-digit code from your authenticator app."
                }}
              </p>
            </div>

            <div class="p-6 pt-0">
              <!-- Inline error -->
              <div
                v-if="errorMsg"
                role="alert"
                class="mb-4 flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div class="min-w-0 space-y-0.5">
                  <p class="break-words">{{ errorMsg }}</p>
                  <p v-if="errorRequestId" class="font-mono text-xs text-muted-foreground tabular">
                    req {{ errorRequestId }}
                  </p>
                </div>
              </div>

              <!-- Password step -->
              <form v-if="step === 'password'" class="space-y-4" @submit.prevent="onSubmitPassword">
                <div class="space-y-2">
                  <Label for="username">Username</Label>
                  <div class="relative">
                    <User
                      class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id="username"
                      v-model="username"
                      type="text"
                      autocomplete="username"
                      autocapitalize="none"
                      spellcheck="false"
                      class="pl-9"
                      :disabled="pending"
                      required
                    />
                  </div>
                </div>

                <div class="space-y-2">
                  <Label for="password">Password</Label>
                  <div class="relative">
                    <Lock
                      class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id="password"
                      v-model="password"
                      type="password"
                      autocomplete="current-password"
                      class="pl-9"
                      :disabled="pending"
                      required
                    />
                  </div>
                </div>

                <Button type="submit" class="w-full" :disabled="pending">
                  <Loader2 v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
                  <span>{{ pending ? "Signing in…" : "Sign in" }}</span>
                </Button>
              </form>

              <!-- TOTP step -->
              <form v-else class="space-y-4" @submit.prevent="onSubmitTotp">
                <template v-if="!useRecovery">
                  <div class="space-y-2">
                    <Label for="totp">Authentication code</Label>
                    <div class="relative">
                      <KeyRound
                        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        id="totp"
                        ref="totpInput"
                        v-model="code"
                        type="text"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        :maxlength="6"
                        placeholder="000000"
                        class="pl-9 font-mono tabular tracking-[0.4em]"
                        :disabled="pending"
                        required
                      />
                    </div>
                  </div>
                </template>

                <template v-else>
                  <div class="space-y-2">
                    <Label for="recovery">Recovery code</Label>
                    <div class="relative">
                      <KeyRound
                        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        id="recovery"
                        v-model="recovery"
                        type="text"
                        autocomplete="off"
                        autocapitalize="none"
                        spellcheck="false"
                        placeholder="xxxx-xxxx-xxxx"
                        class="pl-9 font-mono"
                        :disabled="pending"
                        required
                      />
                    </div>
                  </div>
                </template>

                <Button type="submit" class="w-full" :disabled="pending">
                  <Loader2 v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
                  <span>{{ pending ? "Verifying…" : "Verify" }}</span>
                </Button>

                <div class="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                    @click="backToPassword"
                  >
                    <ArrowLeft class="size-3.5" aria-hidden="true" />
                    Back
                  </button>
                  <button
                    type="button"
                    class="text-muted-foreground transition-colors hover:text-foreground"
                    @click="(useRecovery = !useRecovery), clearError()"
                  >
                    {{ useRecovery ? "Use authenticator code" : "Use a recovery code" }}
                  </button>
                </div>
              </form>

              <!-- SSO providers -->
              <template v-if="step === 'password' && providers.length">
                <div class="relative my-6">
                  <Separator />
                  <span
                    class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    or
                  </span>
                </div>
                <div class="space-y-2">
                  <Button
                    v-for="p in providers"
                    :key="p.id"
                    type="button"
                    variant="outline"
                    class="w-full"
                    @click="startSso(p.id)"
                  >
                    Sign in with {{ p.display_name || p.id }}
                  </Button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
