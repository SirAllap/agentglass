/*
 * After `click` and `press`: wait for what the act caused, then say what it
 * was (`effect`).
 *
 * The flat 250 ms this replaces was too long for a click that changes nothing
 * and too short for one whose request takes longer — measured on agx-bench,
 * click p50 550 ms against type's 210. These drive the real driver against a
 * stand-in guest that scripts the three things a page can do after a click:
 * nothing, keep changing, or navigate.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk, type DrivableWebview } from "../src/lib/browserDrive.ts";

type Scenario = {
  /** What the page's mutation counter and in-flight count read on the n-th poll. */
  poll?: (n: number) => [number, number];
  /** Run as the act happens — emit navigation events from here. */
  onAct?: (emit: (type: string, props?: Record<string, unknown>) => void) => void;
  effect?: Record<string, unknown>;
  url?: () => string;
  /** The page is mid-load before anything happens. */
  loading?: boolean;
  /** How the page answers `history.back()`: it runs (default) or cannot. */
  pageHistory?: "runs" | "throws";
};

function guest(sc: Scenario = {}) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const ran: string[] = [];
  let polls = 0;
  /* Electron holds an executeJavaScript until the main frame stops loading
     (its waitTillCanExecuteJavaScript); the stand-in does the same, or a wait
     that blocks in the real thing would pass here. */
  let loading = false;
  let loaded: Array<() => void> = [];
  const emit = (type: string, props: Record<string, unknown> = {}) => {
    if (type === "did-start-navigation" && props.isMainFrame !== false && !props.isInPlace) loading = true;
    if (type === "did-stop-loading") { loading = false; for (const f of loaded.splice(0)) f(); }
    for (const fn of listeners.get(type) ?? []) fn(Object.assign(new Event(type), props));
  };
  const el: DrivableWebview & { ran: string[]; listening: () => number } = {
    ran,
    listening: () => [...listeners.values()].reduce((a, s) => a + s.size, 0),
    loadURL: async () => {},
    goBack: () => { ran.push("goBack"); sc.onAct?.(emit); }, goForward: () => { ran.push("goForward"); },
    canGoBack: () => true, canGoForward: () => false,
    getURL: () => sc.url?.() ?? "http://127.0.0.1:4000/app",
    getTitle: () => "Orbit",
    reload: () => {}, reloadIgnoringCache: () => {},
    capturePage: async () => ({ toDataURL: () => "" }),
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); },
    removeEventListener: (t, fn) => { listeners.get(t)?.delete(fn); },
    isLoading: () => loading || !!sc.loading,
    executeJavaScript: async (code: string) => {
      if (loading) await new Promise<void>((r) => loaded.push(r));
      ran.push(code);
      if (code.includes("window.__agxMut, l = window.__agxLog")) return (sc.poll ?? (() => [0, 0]))(polls++);
      if (code.includes("newErrors:")) return sc.effect ?? { newErrors: [], failedRequests: [] };
      if (code.includes("history.back()") || code.includes("history.forward()")) {
        if (sc.pageHistory === "throws") throw new Error("Script failed to execute");
        setTimeout(() => sc.onAct?.(emit), 5);
        return true;
      }
      // The act itself: the page acts, then answers.
      setTimeout(() => sc.onAct?.(emit), 5);
      return { kind: "ok", t0: 1_000 };
    },
  };
  return el;
}

const click = (el: DrivableWebview) => runBrowserAsk(el, { id: "b1", op: "click", args: { selector: "e4" } } as never);
const effectOf = (r: { value?: unknown }) => (r.value as { effect: Record<string, any> }).effect;

describe("a click waits for what it caused", () => {
  test("a click that changes nothing answers once the page is quiet — well under the old 250 ms", async () => {
    const t = Date.now();
    const r = await click(guest());
    const e = effectOf(r);
    expect(r.ok).toBe(true);
    expect(e.settledBy).toBe("quiet");
    expect(e.navigated).toBe(false);
    expect(e.settleMs).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t).toBeLessThan(250);
    // Nothing happened, so nothing is claimed.
    for (const k of ["newDocument", "newErrors", "failedRequests", "dialog"]) expect(e[k]).toBeUndefined();
  });

  test("a request in flight holds the answer until it is back", async () => {
    // In flight for the first 12 polls (~300 ms), then the page renders the result.
    const r = await click(guest({ poll: (n) => (n < 12 ? [0, 1] : [n === 12 ? 1 : 2, 0]) }));
    const e = effectOf(r);
    expect(e.settledBy).toBe("quiet");
    expect(e.settleMs).toBeGreaterThanOrEqual(300);
  });

  test("a page that never stops changing is capped, not waited on forever", async () => {
    const r = await click(guest({ poll: (n) => [n, 0] }));
    const e = effectOf(r);
    expect(r.ok).toBe(true);
    expect(e.settledBy).toBe("cap");
    expect(e.settleMs).toBeGreaterThanOrEqual(1_000);
    expect(e.settleMs).toBeLessThan(1_500);
  });

  test("a click that navigates waits for the new document and says so", async () => {
    let url = "http://127.0.0.1:4000/docs/1";
    const el = guest({
      url: () => url,
      onAct: (emit) => {
        emit("did-start-navigation", { isMainFrame: true, isInPlace: false, url: "http://127.0.0.1:4000/docs/2" });
        setTimeout(() => { url = "http://127.0.0.1:4000/docs/2"; emit("did-stop-loading"); }, 300);
      },
    });
    const r = await click(el);
    const e = effectOf(r);
    expect(e.settledBy).toBe("navigation");
    expect(e.navigated).toBe(true);
    expect(e.newDocument).toBe(true);
    expect(e.settleMs).toBeGreaterThanOrEqual(290);
    expect((r.value as { url: string }).url).toBe("http://127.0.0.1:4000/docs/2");
  });

  test("a client-side route is a navigation, not a new document", async () => {
    const r = await click(guest({ onAct: (emit) => emit("did-navigate-in-page", { isMainFrame: true, url: "http://127.0.0.1:4000/items" }) }));
    const e = effectOf(r);
    expect(e.navigated).toBe(true);
    expect(e.newDocument).toBeUndefined();
    expect(e.settledBy).toBe("quiet");
  });

  test("a subframe navigating is not the page navigating", async () => {
    const r = await click(guest({ onAct: (emit) => emit("did-start-navigation", { isMainFrame: false, isInPlace: false }) }));
    expect(effectOf(r).navigated).toBe(false);
    expect(effectOf(r).settledBy).toBe("quiet");
  });

  test("the errors, failed requests and dialog the click caused ride on the answer", async () => {
    const r = await click(guest({ effect: {
      newErrors: ["TypeError: Cannot read properties of undefined (reading 'price')"],
      failedRequests: [{ method: "GET", url: "http://127.0.0.1:4000/api/widgets", status: 500 }],
      dialog: { kind: "confirm", message: "Discard the draft?", at: 1_001, answered: true },
    } }));
    const e = effectOf(r);
    expect(e.newErrors[0]).toContain("reading 'price'");
    expect(e.failedRequests[0].status).toBe(500);
    expect(e.dialog.kind).toBe("confirm");
  });

  test("every listener it added is gone afterwards, on success and on refusal", async () => {
    const el = guest();
    await click(el);
    expect(el.listening()).toBe(0);
    const blocked = guest();
    blocked.executeJavaScript = async () => ({ kind: "blocked", reason: "covered by e42 .modal" });
    const r = await click(blocked);
    expect(r.ok).toBe(false);
    expect((blocked as unknown as { listening: () => number }).listening()).toBe(0);
  });

  test("the mutation counter is on before the click, so the click's own change is counted", async () => {
    const el = guest();
    await click(el);
    const act = el.ran[0]!;
    expect(act.indexOf("new MutationObserver")).toBeGreaterThan(-1);
    expect(act.indexOf("new MutationObserver")).toBeLessThan(act.indexOf("e.click()"));
    // childList and text only: a style attribute animating every frame would never be quiet.
    expect(act).toContain("childList: true, characterData: true }");
    expect(act).not.toContain("attributes: true");
  });
});

describe("the caps hold while a document is loading", () => {
  test("a navigation that never finishes is given up on at the cap, and the answer still comes", async () => {
    const el = guest({ onAct: (emit) => emit("did-start-navigation", { isMainFrame: true, isInPlace: false }) });
    const r = await click(el);
    const e = effectOf(r);
    expect(r.ok).toBe(true);
    expect(e.settledBy).toBe("cap");
    expect(e.newDocument).toBe(true);
    expect(e.settleMs).toBeGreaterThanOrEqual(4_900);
    expect(e.settleMs).toBeLessThan(5_600);
    // Nothing was sent to a page that could not answer until it loaded.
    expect(el.ran.some((c) => c.includes("newErrors:"))).toBe(false);
  }, 10_000);
});

describe("press settles the same way", () => {
  test("Enter that submits and navigates is waited for", async () => {
    const el = guest({
      onAct: (emit) => {
        emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
        setTimeout(() => emit("did-stop-loading"), 150);
      },
    });
    const r = await runBrowserAsk(el, { id: "b2", op: "press", args: { key: "Enter" } } as never);
    expect(r.ok).toBe(true);
    const e = effectOf(r);
    expect(e.settledBy).toBe("navigation");
    expect(e.newDocument).toBe(true);
    expect(el.listening()).toBe(0);
  });
});
