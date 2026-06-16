import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, setCsrfToken, type Principal } from "@/lib/api";

/**
 * Session/auth state. The cookie is owned by the browser; we only track the
 * principal + CSRF token (mirrored into the api client for unsafe requests)
 * and the scope set used for permission-derived navigation.
 */
export const useAuthStore = defineStore("auth", () => {
  const principal = ref<Principal | undefined>(undefined);
  const ready = ref(false); // bootstrap (GET /api/me) has resolved at least once
  const pendingTotpChallenge = ref<string | undefined>(undefined);

  const isAuthenticated = computed(() => !!principal.value);
  const scopes = computed(() => principal.value?.scopes ?? []);

  function applyPrincipal(p: Principal | undefined) {
    principal.value = p;
    setCsrfToken(p?.csrf_token);
  }

  /** Scope check honouring '*' superuser and 'prefix:*' wildcards. */
  function can(required: string): boolean {
    const s = scopes.value;
    if (s.includes("*")) return true;
    if (s.includes(required)) return true;
    const [prefix] = required.split(":");
    return s.includes(`${prefix}:*`);
  }

  function canAny(required: string[]): boolean {
    return required.length === 0 || required.some(can);
  }

  async function bootstrap(): Promise<void> {
    try {
      const me = await api.auth.me();
      applyPrincipal(me);
    } catch {
      applyPrincipal(undefined);
    } finally {
      ready.value = true;
    }
  }

  /** Returns true if logged in; false if a TOTP second factor is required. */
  async function login(username: string, password: string): Promise<boolean> {
    const res = await api.auth.login(username, password);
    if (res.totp_required && res.challenge_id) {
      pendingTotpChallenge.value = res.challenge_id;
      return false;
    }
    await bootstrap();
    return true;
  }

  async function completeTotp(code?: string, recoveryCode?: string): Promise<void> {
    if (!pendingTotpChallenge.value) throw new Error("No pending TOTP challenge");
    await api.auth.loginTotp(pendingTotpChallenge.value, code, recoveryCode);
    pendingTotpChallenge.value = undefined;
    await bootstrap();
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      applyPrincipal(undefined);
    }
  }

  return {
    principal,
    ready,
    pendingTotpChallenge,
    isAuthenticated,
    scopes,
    can,
    canAny,
    bootstrap,
    login,
    completeTotp,
    logout,
  };
});
