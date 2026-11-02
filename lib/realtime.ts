"use client";
// Real-time pages without WebSockets: the existing GET APIs are simply asked again every 2 seconds.
// All the logic lives in lib/liveStore.ts; this file connects it to React and to the browser.
//
//   const { data, error, loading, reload } = useLiveData("/api/transactions");     // same shape as useFetch
//
// Behaviour in short (details in liveStore.ts):
//   - one request per URL however many components use it, never two at the same time;
//   - paused while the tab is hidden, refreshed at once when you come back;
//   - after every action the user takes (any POST / PUT / DELETE through apiFetch) all live data refreshes immediately;
//   - components only re-render when the data really changed, so typing and scrolling are not interrupted.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "./client";
import { onMutation } from "./liveBus";
import { DEFAULT_INTERVAL, IDLE_SNAPSHOT, LOADING_SNAPSHOT, LiveOptions, LiveSnapshot, createLiveStore } from "./liveStore";

export const POLL_INTERVAL_MS = DEFAULT_INTERVAL; // 2 seconds
export type { LiveOptions, LiveSnapshot };

const browserEnv = {
  fetchJson: (url: string, signal: AbortSignal) => apiFetch(url, { signal }),
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  onWake(callback: () => void) {
    const onVisible = () => { if (document.visibilityState === "visible") callback(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", callback);
    window.addEventListener("online", callback);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", callback);
      window.removeEventListener("online", callback);
    };
  },
  now: () => Date.now(),
};

// One store for the whole browser tab. Creating it touches nothing until the first page subscribes (browser only).
const store = createLiveStore(browserEnv);
onMutation(() => store.invalidate());

/** Stop all polling and forget all loaded data. Called when the user logs out. */
export const resetLive = () => store.reset();

/** Drop-in replacement for useFetch whose data stays fresh by itself. `url = null` means "nothing to load". */
export function useLiveData<T = any>(url: string | null, options: LiveOptions = {}) {
  const { interval = POLL_INTERVAL_MS, pollQuery } = options;
  const subscribe = useCallback(
    (notify: () => void) => (url ? store.subscribe(url, notify, { interval, pollQuery }) : () => {}),
    [url, interval, pollQuery]
  );
  const getSnapshot = useCallback(() => store.getSnapshot<T>(url), [url]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => (url ? (LOADING_SNAPSHOT as LiveSnapshot<T>) : (IDLE_SNAPSHOT as LiveSnapshot<T>)));
  const reload = useCallback(() => (url ? store.refresh(url) : Promise.resolve()), [url]);
  return { data: snap.data, error: snap.error, loading: snap.loading, reload, updatedAt: snap.updatedAt };
}

/** Delays changes of a value (for example a URL built from filters the user is typing). null passes through at once. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === shown) return;
    if (value === null || shown === null) { setShown(value); return; }
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}
