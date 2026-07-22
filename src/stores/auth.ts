import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, setCsrfToken, type Principal } from "@/lib/api";
import { allowsRuntimeScope, allowsScopeGrant } from "@/lib/scopes";
import { startAuthentication } from "@/lib/webauthn";

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
  const serverAllowlist = computed(() => principal.value?.server_allowlist ?? []);

  function applyPrincipal(p: Principal | undefined) {
    principal.value = p;
    setCsrfToken(p?.csrf_token);
  }

  /** Runtime scope check, including the server's migration compatibility. */
  function can(required: string): boolean {
    return allowsRuntimeScope(scopes.value, required);
  }

  /** Directed assignment check aligned with server scope-migration rules. */
  function canGrant(candidate: string): boolean {
    return allowsScopeGrant(scopes.value, candidate);
  }

  function canAny(required: string[]): boolean {
    return required.length === 0 || required.some(can);
  }

  function canAll(required: string[]): boolean {
    return required.every(can);
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

  /**
   * Sign in with a passkey (usernameless/discoverable). Runs the WebAuthn
   * assertion ceremony and, on success, establishes the session. A user-verified
   * passkey satisfies both possession and inherence, so no separate second factor
   * is required.
   */
  async function loginWebAuthn(): Promise<void> {
    const begin = await api.auth.webauthnLoginBegin();
    const assertion = await startAuthentication(begin.publicKey);
    await api.auth.webauthnLoginFinish(begin.challenge_id, assertion);
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
    serverAllowlist,
    can,
    canGrant,
    canAny,
    canAll,
    bootstrap,
    login,
    completeTotp,
    loginWebAuthn,
    logout,
  };
});
