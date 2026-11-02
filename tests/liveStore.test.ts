// The polling engine behind the real-time pages (lib/liveStore.ts). No database and no browser: the network, the
// "is the tab visible" question and the wake-up events are replaced by a small fake. Real timers with short
// intervals (20 ms) keep the tests simple.
import { describe, expect, it } from "vitest";
import { LiveEnv, LiveOptions, createLiveStore } from "../lib/liveStore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await sleep(3);
  }
}

type Handler = (url: string, signal: AbortSignal) => Promise<unknown> | unknown;

function setup(handler: Handler) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  let wake: (() => void) | null = null;
  const env = {
    visible: true,
    fetchJson: async (url: string, signal: AbortSignal) => {
      calls.push(url);
      running++;
      maxRunning = Math.max(maxRunning, running);
      try { return await handler(url, signal); } finally { running--; }
    },
    isVisible() { return env.visible; },
    onWake(cb: () => void) { wake = cb; return () => { wake = null; }; },
    now: () => Date.now(),
  };
  const store = createLiveStore(env as LiveEnv);
  return { store, env, calls, maxRunning: () => maxRunning, wake: () => wake?.(), hasWake: () => wake !== null };
}

function watch(store: ReturnType<typeof createLiveStore>, url: string, options: LiveOptions = { interval: 20 }) {
  let notified = 0;
  const off = store.subscribe(url, () => notified++, options);
  return { off, notified: () => notified, snap: () => store.getSnapshot(url) };
}

describe("live store: loading and polling", () => {
  it("loads at once, then asks again every interval", async () => {
    const t = setup(() => ({ n: 1 }));
    const w = watch(t.store, "/api/x");
    expect(w.snap().loading).toBe(true);
    await until(() => w.snap().data !== null);
    expect(w.snap().data).toEqual({ n: 1 });
    expect(w.snap().loading).toBe(false);
    await until(() => t.calls.length >= 4);
    w.off();
  });

  it("never runs two requests for the same URL at the same time, even when the server is slower than the interval", async () => {
    const t = setup(async () => { await sleep(50); return { ok: true }; });
    const w = watch(t.store, "/api/slow", { interval: 5 });
    await sleep(350);
    expect(t.calls.length).toBeGreaterThanOrEqual(3);
    expect(t.maxRunning()).toBe(1);
    w.off();
  });

  it("components that show the same URL share one poller", async () => {
    const t = setup(() => ({ n: 1 }));
    const a = watch(t.store, "/api/shared");
    const b = watch(t.store, "/api/shared");
    expect(t.store.size()).toBe(1);
    await until(() => a.snap().data !== null && b.snap().data !== null);
    await sleep(100);
    expect(t.maxRunning()).toBe(1);
    // one request stream: roughly 100ms / 20ms, not double that
    expect(t.calls.length).toBeLessThanOrEqual(9);
    a.off(); b.off();
  });

  it("interval 0 loads once and never polls", async () => {
    const t = setup(() => ({ n: 1 }));
    const w = watch(t.store, "/api/once", { interval: 0 });
    await until(() => w.snap().data !== null);
    await sleep(100);
    expect(t.calls.length).toBe(1);
    w.off();
  });

  it("a component that needs polling can join a load-once poller", async () => {
    const t = setup(() => ({ n: 1 }));
    const once = watch(t.store, "/api/join", { interval: 0 });
    await until(() => once.snap().data !== null);
    const live = watch(t.store, "/api/join", { interval: 20 });
    await until(() => t.calls.length >= 3);
    once.off(); live.off();
  });
});

describe("live store: only real changes reach the screen", () => {
  it("does not notify when the answer is identical, notifies when it changed", async () => {
    let value = 1;
    const t = setup(() => ({ value }));
    const w = watch(t.store, "/api/same");
    await until(() => w.snap().data !== null);
    const before = w.notified();
    await sleep(120); // several identical polls
    expect(t.calls.length).toBeGreaterThanOrEqual(3);
    expect(w.notified()).toBe(before);
    value = 2;
    await until(() => (w.snap().data as any)?.value === 2);
    expect(w.notified()).toBe(before + 1);
    w.off();
  });

  it("keeps the same snapshot object while nothing changed (so React does not re-render)", async () => {
    const t = setup(() => ({ a: [1, 2, 3] }));
    const w = watch(t.store, "/api/stable");
    await until(() => w.snap().data !== null);
    const first = w.snap();
    await sleep(100);
    expect(w.snap()).toBe(first);
    w.off();
  });
});

describe("live store: tab visibility", () => {
  it("pauses while the tab is hidden and refreshes at once when it is visible again", async () => {
    const t = setup(() => ({ n: Date.now() }));
    const w = watch(t.store, "/api/vis", { interval: 20 });
    await until(() => t.calls.length >= 2);
    t.env.visible = false;
    await sleep(60); // the pending timer fires and finds the tab hidden
    const frozen = t.calls.length;
    await sleep(150);
    expect(t.calls.length).toBe(frozen);
    t.env.visible = true;
    t.wake();
    await until(() => t.calls.length > frozen, 200);
    w.off();
  });
});

describe("live store: user actions", () => {
  it("invalidate() refreshes everything at once, without waiting for the interval", async () => {
    let value = "old";
    const t = setup(() => ({ value }));
    const w = watch(t.store, "/api/act", { interval: 10_000 });
    await until(() => (w.snap().data as any)?.value === "old");
    value = "new"; // somebody changed something on the server
    t.store.invalidate();
    await until(() => (w.snap().data as any)?.value === "new", 300);
    w.off();
  });

  it("an answer that was requested BEFORE the action is not trusted: it is asked again", async () => {
    let value = "before";
    let release: (() => void) | null = null;
    let slowFirst = true;
    const t = setup(async () => {
      const answer = { value }; // the server reads its data now ...
      if (slowFirst) { slowFirst = false; await new Promise<void>((r) => (release = r)); } // ... but the answer travels slowly
      return answer;
    });
    const w = watch(t.store, "/api/race", { interval: 10_000 });
    await until(() => release !== null);
    value = "after"; // the user's action finishes while the first request is still on its way
    t.store.invalidate();
    release!();
    await until(() => (w.snap().data as any)?.value === "after", 500);
    expect(t.calls.length).toBe(2);
    w.off();
  });

  it("reload() right after an action does not send an extra request when the refresh already started", async () => {
    let release: (() => void) | null = null;
    let first = true;
    const t = setup(async () => {
      if (first) { first = false; return { n: 0 }; }
      await new Promise<void>((r) => (release = r));
      return { n: 1 };
    });
    const w = watch(t.store, "/api/dedupe", { interval: 10_000 });
    await until(() => w.snap().data !== null);
    t.store.invalidate(); // an action: the refresh starts now
    await until(() => release !== null);
    void t.store.refresh("/api/dedupe"); // the page calls reload() as well
    release!();
    await until(() => (w.snap().data as any)?.n === 1);
    await sleep(30);
    expect(t.calls.length).toBe(2);
    w.off();
  });
});

describe("live store: errors", () => {
  it("a short network problem keeps the old data on screen, then recovers", async () => {
    let fail = false;
    let value = 1;
    const t = setup(() => { if (fail) throw new Error("network down"); return { value }; });
    const w = watch(t.store, "/api/blip", { interval: 10 });
    await until(() => w.snap().data !== null);
    fail = true;
    await sleep(150);
    expect(w.snap().error).toBeNull(); // not shown: the data on screen is just a few seconds old
    expect((w.snap().data as any).value).toBe(1);
    fail = false; value = 2;
    t.wake(); // back online
    t.store.invalidate();
    await until(() => (w.snap().data as any)?.value === 2, 500);
    expect(w.snap().error).toBeNull();
    w.off();
  });

  it("an error on the very first load is shown, and disappears when the server answers", async () => {
    let fail = true;
    const t = setup(() => { if (fail) throw Object.assign(new Error("Server error"), { status: 500 }); return { ok: 1 }; });
    const w = watch(t.store, "/api/first", { interval: 10 });
    await until(() => w.snap().error === "Server error");
    expect(w.snap().loading).toBe(false);
    fail = false;
    t.store.invalidate();
    await until(() => w.snap().data !== null, 500);
    expect(w.snap().error).toBeNull();
    w.off();
  });

  it("a 4xx answer (logged out, not allowed, not found, bad filter) stops polling and is shown; refresh() tries again", async () => {
    let status = 403;
    const t = setup(() => { if (status !== 200) throw Object.assign(new Error("Not allowed"), { status }); return { ok: 1 }; });
    const w = watch(t.store, "/api/forbidden", { interval: 10 });
    await until(() => w.snap().error === "Not allowed");
    const calls = t.calls.length;
    await sleep(120);
    expect(t.calls.length).toBe(calls); // stopped
    status = 200;
    await t.store.refresh("/api/forbidden");
    expect(w.snap().error).toBeNull();
    expect(w.snap().data).toEqual({ ok: 1 });
    w.off();
  });
});

describe("live store: URLs, cleaning up, logout", () => {
  it("adds the poll marker only after the first successful load", async () => {
    const t = setup(() => ({ ok: 1 }));
    const w = watch(t.store, "/api/listings/5", { interval: 15, pollQuery: "poll=1" });
    await until(() => t.calls.length >= 3);
    expect(t.calls[0]).toBe("/api/listings/5");
    expect(t.calls[1]).toBe("/api/listings/5?poll=1");
    const w2 = watch(t.store, "/api/x?a=1", { interval: 15, pollQuery: "poll=1" });
    await until(() => t.calls.some((c) => c === "/api/x?a=1&poll=1"));
    w.off(); w2.off();
  });

  it("stops polling when the last component leaves, and not before", async () => {
    const t = setup(() => ({ ok: 1 }));
    const a = watch(t.store, "/api/leave");
    const b = watch(t.store, "/api/leave");
    await until(() => t.calls.length >= 2);
    a.off();
    await sleep(10);
    expect(t.store.size()).toBe(1);
    b.off();
    await sleep(30);
    expect(t.store.size()).toBe(0);
    expect(t.hasWake()).toBe(false);
    const calls = t.calls.length;
    await sleep(100);
    expect(t.calls.length).toBe(calls);
  });

  it("a component that leaves and joins again in the same moment keeps its poller (React double mount)", async () => {
    const t = setup(() => ({ ok: 1 }));
    const a = watch(t.store, "/api/remount");
    await until(() => a.snap().data !== null);
    a.off();
    const b = watch(t.store, "/api/remount");
    await sleep(30);
    expect(t.store.size()).toBe(1);
    expect(b.snap().data).toEqual({ ok: 1 });
    expect(t.calls.length).toBeLessThanOrEqual(3);
    b.off();
  });

  it("reset() (logout) forgets all data, aborts running requests and tells the screens", async () => {
    let aborted = false;
    let hang = false;
    let hanging = 0;
    const t = setup(async (_url, signal) => {
      if (hang) {
        hanging++;
        await new Promise<void>((_r, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }));
      }
      return { secret: "account A" };
    });
    const w = watch(t.store, "/api/private", { interval: 10 });
    await until(() => w.snap().data !== null);
    hang = true;
    await until(() => hanging > 0); // a request is on its way when the user logs out
    const before = w.notified();
    t.store.reset();
    expect(t.store.size()).toBe(0);
    expect(w.snap().data).toBeNull(); // nothing of account A is left to show
    expect(w.snap().loading).toBe(true);
    expect(w.notified()).toBe(before + 1);
    await sleep(30);
    expect(aborted).toBe(true);
    const calls = t.calls.length;
    await sleep(80);
    expect(t.calls.length).toBe(calls);
  });

  it("a different URL is a different poller with its own data", async () => {
    const t = setup((url) => ({ url }));
    const a = watch(t.store, "/api/conversations/1");
    const b = watch(t.store, "/api/conversations/2");
    await until(() => a.snap().data !== null && b.snap().data !== null);
    expect(a.snap().data).toEqual({ url: "/api/conversations/1" });
    expect(b.snap().data).toEqual({ url: "/api/conversations/2" });
    a.off(); b.off();
  });
});
