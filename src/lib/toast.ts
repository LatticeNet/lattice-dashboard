/**
 * The console's toast. Every view imports `toast` from here, never from
 * vue-sonner directly (lib/__tests__/toastImports.audit.test.ts keeps it
 * that way), so the rules below hold everywhere:
 *
 * - An error shows for 15 s, not vue-sonner's 4 s, with a close button.
 *   Error text is often a server refusal with a request id, longer than
 *   anyone reads in 4 s, and the toast was frequently the only place the
 *   reason appeared. vue-sonner already pauses the timer while the pointer
 *   is on the toasts and while the tab is hidden. Successes and notes keep
 *   the default 4 s.
 * - Every error is also kept in the recent errors list the header shows, so a
 *   dismissed or missed one can be read again, until the principal changes.
 *
 * Errors do not stay until dismissed: from 768 px up toasts sit top right,
 * over the header's own controls (search, recent errors, theme, account),
 * and a toast that never leaves blocks them until the operator finds its
 * close button. The recent errors list is what keeps an error reachable.
 */
import { shallowRef } from "vue";
import { toast as sonner } from "vue-sonner";
import { ErrorLog, type RecentError } from "./recentErrors";

type Sonner = typeof sonner;
type ErrorFn = Sonner["error"];

/** How long an error toast shows, unless hovered or the tab is hidden. */
export const ERROR_TOAST_MS = 15_000;

const log = new ErrorLog();
const recent = shallowRef<RecentError[]>([]);

/** The errors shown in this tab, newest first. */
export const recentErrors = recent;

export function clearRecentErrors(): void {
  recent.value = log.clear();
}

/**
 * Tie the recent errors to the signed-in principal: stores/auth calls this
 * whenever the principal changes, and a different one (or none) starts the
 * list empty.
 */
export function setRecentErrorsOwner(owner: string | undefined): void {
  if (log.belongTo(owner)) recent.value = log.list;
}

function plain(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const error: ErrorFn = (message, data) => {
  const text = plain(message);
  if (text) recent.value = [...log.add(text, Date.now(), plain(data?.description))];
  return sonner.error(message, { duration: ERROR_TOAST_MS, closeButton: true, ...data });
};

export const toast: Sonner = Object.assign((...args: Parameters<Sonner>) => sonner(...args), sonner, { error });
