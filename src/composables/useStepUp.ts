import { ref } from "vue";
import { api } from "@/lib/api";
import {
  isPasskeyCancellation,
  isWebAuthnSupported,
  startAuthentication,
} from "@/lib/webauthn";

export interface StepUpCopy {
  required: string;
  failed: string;
  passkeyFailed: string;
}

export function useStepUp(copy: StepUpCopy) {
  const open = ref(false);
  const code = ref("");
  const error = ref("");
  const pending = ref<"" | "totp" | "passkey">("");
  const grant = ref("");
  const grantExpiresAt = ref(0);
  const supportsPasskey = isWebAuthnSupported();

  let resolveGrant: ((grant: string) => void) | undefined;
  let rejectGrant: ((error: Error) => void) | undefined;

  function cachedGrant(): string {
    if (grant.value && Date.now() < grantExpiresAt.value - 1000) return grant.value;
    return "";
  }

  function accept(nextGrant: string, expiresAt: string) {
    grant.value = nextGrant;
    grantExpiresAt.value = Date.parse(expiresAt);
    open.value = false;
    resolveGrant?.(nextGrant);
    resolveGrant = undefined;
    rejectGrant = undefined;
  }

  function request(): Promise<string> {
    const cached = cachedGrant();
    if (cached) return Promise.resolve(cached);
    code.value = "";
    error.value = "";
    open.value = true;
    return new Promise((resolve, reject) => {
      resolveGrant = resolve;
      rejectGrant = reject;
    });
  }

  async function submitTotp() {
    const trimmed = code.value.trim();
    if (!trimmed || pending.value) return;
    pending.value = "totp";
    error.value = "";
    try {
      const result = await api.security.stepUp(trimmed);
      accept(result.grant, result.expires_at);
    } catch (err) {
      error.value = err instanceof Error ? err.message : copy.failed;
    } finally {
      pending.value = "";
    }
  }

  async function submitPasskey() {
    if (!supportsPasskey || pending.value) return;
    pending.value = "passkey";
    error.value = "";
    try {
      const begin = await api.security.stepUpWebAuthnBegin();
      const credential = await startAuthentication(begin.publicKey);
      const result = await api.security.stepUpWebAuthnFinish(begin.challenge_id, credential);
      accept(result.grant, result.expires_at);
    } catch (err) {
      if (!isPasskeyCancellation(err)) {
        error.value = err instanceof Error ? err.message : copy.passkeyFailed;
      }
    } finally {
      pending.value = "";
    }
  }

  function cancel() {
    open.value = false;
    rejectGrant?.(new Error(copy.required));
    resolveGrant = undefined;
    rejectGrant = undefined;
  }

  return {
    open,
    code,
    error,
    pending,
    supportsPasskey,
    request,
    submitTotp,
    submitPasskey,
    cancel,
  };
}
