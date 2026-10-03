/**
 * How the server refuses a wrong or reused passcode: lattice-server's
 * step-up answers 401 "invalid second factor", the dev harness 401 "invalid
 * or expired passcode". useStepUp shows either as the console's own
 * sentence (common.stepUp.rejected), so a zh-CN console never shows the
 * server's English. Any other refusal keeps the server's reason.
 */
import { ApiError } from "@/lib/api/client";

const REJECTED_PASSCODE = new Set(["invalid second factor", "invalid or expired passcode"]);

export function isRejectedPasscode(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && REJECTED_PASSCODE.has(err.serverMessage.trim().toLowerCase());
}
