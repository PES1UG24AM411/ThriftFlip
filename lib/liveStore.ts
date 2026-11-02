// The engine behind "live" pages: keeps data fresh by asking the existing GET APIs again every few seconds.
// It has no React and no browser globals (everything comes in through `LiveEnv`), so it is easy to test.
// lib/realtime.ts connects it to React (`useLiveData`) and to the browser.
//
// What it guarantees
//   * One poller per URL, shared by every component that shows that URL (the bell in the navigation bar and the
//     Notifications page share one request, not two).
//   * Never two requests for the same URL at the same time: the next poll is scheduled only after the previous
//     one has finished.
//   * Nothing is requested while the browser tab is hidden. When the tab is visible again (or the window gets
//     focus, or the network is back) it refreshes at once.
//   * A component is only told about NEW data: if the answer is identical to the last one nothing re-renders, so
//     typing, scrolling and focus are never disturbed by a poll that found no change.
//   * A short network or server hiccup keeps the old data on screen and retries with a growing delay.
//     "Not allowed / not found / bad request" answers (4xx) stop the polling and are shown.
//   * invalidate() (called after every user action) refreshes everything immediately. A request that started
//     before the action is repeated, because its answer may be out of date.

export interface LiveSnapshot<T = any> {
  data: T | null;
  error: string | null;
  /** true until the first answer (data or error) has arrived */
  loading: boolean;
  updatedAt: number | null;
}

export interface LiveOptions {
  /** milliseconds between polls (default 2000). 0 = load once, never poll. */
  interval?: number;
  /** Added to every request after the first successful one, e.g. "poll=1".
   *  Lets the server tell "the page was opened" from "a background refresh". */
  pollQuery?: string;
}

export interface LiveEnv {
  fetchJson(url: string, signal: AbortSignal): Promise<unknown>;
  isVisible(): boolean;
  /** calls back when the tab becomes visible, the window gets focus or the network returns; returns an unsubscribe function */
  onWake(callback: () => void): () => void;
  now(): number;
}

export const DEFAULT_INTERVAL = 2000;
export const MAX_BACKOFF = 15000;

export const IDLE_SNAPSHOT: LiveSnapshot = Object.freeze({ data: null, error: null, loading: false, updatedAt: null });
export const LOADING_SNAPSHOT: LiveSnapshot = Object.freeze({ data: null, error: null, loading: true, updatedAt: null });

// 4xx answers will not fix themselves (not logged in, not allowed, not found, invalid filter): stop polling.
// 408 (timeout) and 429 (slow down) are temporary, so they are retried like network errors.
function isFatal(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function withQuery(url: string, query: string | undefined): string {
  if (!query) return url;
  return url + (url.includes("?") ? "&" : "?") + query;
}

interface Subscriber {
  notify: () => void;
  interval: number;
  pollQuery?: string;
}

type Inflight = { promise: Promise<void>; epoch: number; controller: AbortController };

class Entry {
  snapshot: LiveSnapshot = LOADING_SNAPSHOT;
  readonly subscribers = new Set<Subscriber>();

  private json: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Inflight | null = null;
  private dirty = false; // an action happened while a request was running: ask again straight afterwards
  private paused = false; // the timer fired while the tab was hidden
  private stopped = false; // a 4xx answer: no more polling until someone asks explicitly
  private failures = 0;
  private hasData = false;
  private alive = true;
  private lastFinished = 0;

  constructor(
    readonly url: string,
    private readonly store: StoreInternals,
    private readonly env: LiveEnv
  ) {}

  private interval(): number {
    let best = 0;
    this.subscribers.forEach((s) => {
      if (s.interval > 0 && (best === 0 || s.interval < best)) best = s.interval;
    });
    return best;
  }

  private pollQuery(): string | undefined {
    for (const s of this.subscribers) if (s.pollQuery) return s.pollQuery;
    return undefined;
  }

  private emit() {
    this.subscribers.forEach((s) => s.notify());
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** A component joined this poller. It may want polling where there was none ("load once") or a faster poll. */
  addSubscriber(sub: Subscriber) {
    const before = this.interval();
    this.subscribers.add(sub);
    const now = this.interval();
    const wantsSooner = now > 0 && (before === 0 || now < before);
    // while a request is running, scheduleNext() is called when it finishes, with the new interval
    if (wantsSooner && this.alive && !this.inflight && !this.stopped) this.scheduleNext();
  }

  start() {
    void this.run();
  }

  /** "make the data fresh": used after user actions and by reload() */
  refresh(): Promise<void> {
    if (!this.alive) return Promise.resolve();
    this.stopped = false;
    this.failures = 0;
    if (this.inflight) {
      // A request that started after the latest action already carries its result; an older one does not.
      if (this.inflight.epoch !== this.store.epoch) this.dirty = true;
      return this.inflight.promise;
    }
    this.clearTimer();
    return this.run();
  }

  /** the tab is visible again / focused / back online */
  wake() {
    if (!this.alive || this.inflight || !this.env.isVisible()) return;
    const interval = this.interval();
    if (interval === 0) return; // "load once" data does not refresh by itself
    const due = this.paused || this.stopped || this.env.now() - this.lastFinished >= interval;
    if (!due) return;
    this.stopped = false;
    this.failures = 0;
    this.clearTimer();
    void this.run();
  }

  destroy() {
    this.alive = false;
    this.clearTimer();
    this.inflight?.controller.abort();
    this.inflight = null;
  }

  private run(): Promise<void> {
    if (this.inflight) {
      this.dirty = true;
      return this.inflight.promise;
    }
    this.clearTimer();
    this.paused = false;
    const controller = new AbortController();
    const url = this.hasData ? withQuery(this.url, this.pollQuery()) : this.url;
    const epoch = this.store.epoch;

    const promise = (async () => {
      try {
        const data = await this.env.fetchJson(url, controller.signal);
        if (!this.alive || controller.signal.aborted) return;
        this.onSuccess(data);
      } catch (err) {
        if (!this.alive || controller.signal.aborted) return;
        this.onError(err);
      }
    })().then(() => {
      if (this.inflight?.controller !== controller) return; // destroyed or replaced meanwhile
      this.inflight = null;
      this.lastFinished = this.env.now();
      if (!this.alive) return;
      if (this.dirty) {
        this.dirty = false;
        void this.run();
      } else {
        this.scheduleNext();
      }
    });

    this.inflight = { promise, epoch, controller };
    return promise;
  }

  private scheduleNext() {
    this.clearTimer();
    const base = this.interval();
    if (!this.alive || base <= 0 || this.stopped) return;
    const delay = this.failures > 0 ? Math.min(base * 2 ** this.failures, MAX_BACKOFF) : base;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.env.isVisible()) {
        this.paused = true; // wake() restarts it
        return;
      }
      void this.run();
    }, delay);
  }

  private onSuccess(data: unknown) {
    this.failures = 0;
    this.stopped = false;
    this.hasData = true;
    const json = JSON.stringify(data);
    if (json === this.json && this.snapshot.error === null) return; // nothing changed: do not re-render anybody
    this.json = json;
    this.snapshot = { data, error: null, loading: false, updatedAt: this.env.now() };
    this.emit();
  }

  private onError(err: unknown) {
    this.failures += 1;
    const status = (err as { status?: number } | null)?.status;
    const message = err instanceof Error ? err.message : String(err);
    const fatal = isFatal(status);
    if (fatal) this.stopped = true;
    // A short hiccup while data is already on screen stays invisible (the old data is kept and we retry).
    if (!fatal && this.hasData) return;
    if (this.snapshot.error === message && !this.snapshot.loading) return;
    this.snapshot = { ...this.snapshot, error: message, loading: false };
    this.emit();
  }
}

interface StoreInternals {
  epoch: number;
}

export function createLiveStore(env: LiveEnv) {
  const entries = new Map<string, Entry>();
  const internals: StoreInternals = { epoch: 0 };
  let unwake: (() => void) | null = null;

  function ensureWake() {
    if (unwake) return;
    unwake = env.onWake(() => entries.forEach((e) => e.wake()));
  }
  function releaseWake() {
    if (entries.size === 0 && unwake) {
      unwake();
      unwake = null;
    }
  }

  return {
    /** Start (or join) the poller for `url`. Returns the function that leaves it again. */
    subscribe(url: string, notify: () => void, options: LiveOptions = {}): () => void {
      const sub: Subscriber = { notify, interval: options.interval ?? DEFAULT_INTERVAL, pollQuery: options.pollQuery };
      let entry = entries.get(url);
      if (!entry) {
        entry = new Entry(url, internals, env);
        entries.set(url, entry);
        entry.subscribers.add(sub);
        ensureWake();
        entry.start();
      } else {
        entry.addSubscriber(sub);
      }
      const joined = entry;
      return () => {
        joined.subscribers.delete(sub);
        if (joined.subscribers.size > 0) return;
        // Leave a moment before shutting down: React may unsubscribe and subscribe again straight away
        // (development double-mount, or a page that changes only its URL).
        setTimeout(() => {
          if (joined.subscribers.size === 0 && entries.get(url) === joined) {
            joined.destroy();
            entries.delete(url);
            releaseWake();
          }
        }, 0);
      };
    },

    getSnapshot<T = any>(url: string | null): LiveSnapshot<T> {
      if (!url) return IDLE_SNAPSHOT;
      return (entries.get(url)?.snapshot as LiveSnapshot<T> | undefined) ?? LOADING_SNAPSHOT;
    },

    /** fetch one URL again right now (used by reload()) */
    refresh(url: string): Promise<void> {
      return entries.get(url)?.refresh() ?? Promise.resolve();
    },

    /** Something was changed on the server (a user action): everything that is on screen refreshes now. */
    invalidate(): void {
      internals.epoch += 1;
      entries.forEach((e) => void e.refresh());
    },

    /** Stop everything and forget all data (logout): nothing from one account may be shown to the next. */
    reset(): void {
      const old = [...entries.values()];
      entries.clear();
      old.forEach((e) => e.destroy());
      releaseWake();
      old.forEach((e) => e.subscribers.forEach((s) => s.notify())); // mounted components fall back to "loading"
    },

    /** number of running pollers (for tests) */
    size: () => entries.size,
  };
}

export type LiveStore = ReturnType<typeof createLiveStore>;
