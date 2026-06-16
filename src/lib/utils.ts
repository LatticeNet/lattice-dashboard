import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className merge used by every ui/ primitive. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** reka-ui v-model helper: assign either a ref or a setter. */
export function valueUpdater<T>(updaterOrValue: T, ref: { value: T }) {
  ref.value =
    typeof updaterOrValue === "function"
      ? (updaterOrValue as (old: T) => T)(ref.value)
      : updaterOrValue;
}
