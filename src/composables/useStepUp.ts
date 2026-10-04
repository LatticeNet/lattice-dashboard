import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/lib/api";
import { isRejectedPasscode } from "@/lib/stepUpRefusal";
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

/**
 * After a refused code, focus goes back to the form's code field with the
 * code selected, so the next attempt is typed over it. Without this it fell
 * to the page: the submit button is disabled under focus while the check
 * runs. Every step-up form marks its field autocomplete="one-time-code".
 */
async function refocusCode(form: HTMLFormElement | null | undefined): Promise<void> {
  await nextTick();
  const input = form?.isConnected ? form.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]') : null;
  input?.focus();
  input?.select();
}

export function useStepUp(copy: StepUpCopy) {
  const { t } = useI18n();
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
    // The form being submitted: the focused field or button sits inside it.
    const form = typeof document === "undefined" ? null : document.activeElement?.closest("form");
    pending.value = "totp";
    error.value = "";
    try {
      const result = await api.security.stepUp(trimmed);
      accept(result.grant, result.expires_at);
    } catch (err) {
      error.value = isRejectedPasscode(err) ? t("common.stepUp.rejected") : err instanceof Error ? err.message : copy.failed;
      pending.value = "";
      await refocusCode(form);
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
    /** The grant still inside its lifetime, or "", without prompting. */
    peek: cachedGrant,
    request,
    submitTotp,
    submitPasskey,
    cancel,
  };
}
