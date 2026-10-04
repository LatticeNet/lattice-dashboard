/**
 * Map one or more useAsyncData reads to a proof line's state (design 23,
 * section 3.1), so a page binds `v-bind="proof"` and never computes
 * freshness on its own.
 *
 *   const proof = useProof(nodesQuery);
 *   <ProofLine v-bind="proof" :segments="segments" @retry="nodesQuery.refresh" />
 *
 * Several reads make one line when a page's numbers come from more than one
 * request (Tasks reads tasks and results). The line then speaks for the
 * weakest of them: the oldest observation, the first error, and a failure
 * before any read has landed wins over everything else.
 */
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { useNow } from "@vueuse/core";

import { proofReason, proofState, type ProofState } from "@/components/common/proofModel";
import type { AsyncData } from "./useAsyncData";

type ProofSource = Pick<AsyncData<unknown>, "data" | "error" | "loading" | "refreshing" | "lastUpdated" | "pollMs">;

export interface ProofBinding {
  state: ProofState;
  observedAt: number | null;
  pollMs: number;
  error: string | null;
}

const PRECEDENCE: ProofState[] = ["failed", "loading", "stale", "refreshing", "observed", "idle"];

export interface UseProofOptions {
  /**
   * Whether the read holds something to show. Defaults to "data is defined";
   * a page whose answer can be defined but empty in a way that means "not
   * read" (a 404 from an older server) passes its own test.
   */
  hasData?: MaybeRefOrGetter<boolean | undefined>;
}

/**
 * A getter in place of the list lets the reads change with the page's state
 * (Monitoring's Topology speaks for the reads its current filter draws from).
 */
export function useProof(sources: ProofSource | ProofSource[] | (() => ProofSource[]), options: UseProofOptions = {}): ComputedRef<ProofBinding> {
  const now = useNow({ interval: 1000 });

  return computed<ProofBinding>(() => {
    const list = typeof sources === "function" ? sources() : Array.isArray(sources) ? sources : [sources];
    const override = toValue(options.hasData);
    const states = list.map((source) =>
      proofState({
        hasData: override ?? source.data.value !== undefined,
        pending: source.loading.value || source.refreshing.value,
        error: source.error.value,
        observedAt: source.lastUpdated.value ?? null,
        pollMs: source.pollMs,
        now: now.value.getTime(),
      }),
    );
    const state = PRECEDENCE.find((candidate) => states.includes(candidate)) ?? "idle";
    const observed = list.map((source) => source.lastUpdated.value).filter((value): value is number => value !== undefined);
    const polled = list.map((source) => source.pollMs).filter((ms) => ms > 0);
    const failing = list.find((source) => source.error.value);
    return {
      state,
      observedAt: observed.length ? Math.min(...observed) : null,
      pollMs: polled.length ? Math.min(...polled) : 0,
      error: failing ? proofReason(failing.error.value) : null,
    };
  });
}
