import { ref, shallowRef, onScopeDispose, watch, type Ref, type ShallowRef } from "vue";
import { useDocumentVisibility } from "@vueuse/core";

/**
 * Data fetching with optional visibility-aware polling — the backbone of the
 * dashboard's "live" feel given the server exposes NO websocket/SSE. Each run
 * aborts the previous in-flight request, keeps the last good value on error
 * (so a transient blip doesn't blank the screen), and pauses while the tab is
 * hidden, resuming instantly on return.
 */
export interface UseAsyncDataOptions {
  immediate?: boolean;
  /** Poll interval in ms; 0 disables polling (one-shot). */
  pollInterval?: number;
  pauseWhenHidden?: boolean;
}

export interface AsyncData<T> {
  data: ShallowRef<T | undefined>;
  error: ShallowRef<Error | undefined>;
  loading: Ref<boolean>;
  refreshing: Ref<boolean>;
  lastUpdated: Ref<number | undefined>;
  refresh: () => Promise<void>;
  stop: () => void;
}

export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: UseAsyncDataOptions = {},
): AsyncData<T> {
  const { immediate = true, pollInterval = 0, pauseWhenHidden = true } = options;

  const data = shallowRef<T | undefined>(undefined);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(false); // first load, no data yet
  const refreshing = ref(false); // background refresh
  const lastUpdated = ref<number | undefined>(undefined);

  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const visibility = useDocumentVisibility();

  async function run(): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    if (data.value === undefined) loading.value = true;
    else refreshing.value = true;

    try {
      const res = await fetcher(controller.signal);
      data.value = res;
      error.value = undefined;
      lastUpdated.value = Date.now();
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      error.value = e as Error;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (pollInterval > 0) {
      timer = setInterval(() => {
        if (pauseWhenHidden && visibility.value === "hidden") return;
        run();
      }, pollInterval);
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    controller?.abort();
  }

  watch(visibility, (v, old) => {
    if (v === "visible" && old === "hidden" && pollInterval > 0) run();
  });

  if (immediate) run();
  schedule();
  onScopeDispose(stop);

  return { data, error, loading, refreshing, lastUpdated, refresh: run, stop };
}
