/*
 * Guide mode at the relay: the lock, the guide verbs, and the audit.
 *
 * A guide is an agent walking the person through their own page while the
 * person clicks. These drive the real door (`parseAsk` then `askBrowser`)
 * against a stand-in panel, so what is checked is what an agent meets: which
 * asks are refused, with which sentence, and that a refused act never reaches
 * the panel at all — the person's log and dock cannot show what never came.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __setBrowserAsker, askBrowser, parseAsk, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { GUIDE_IDLE_MS, guideCount, resetGuides, setGuideClock } from "../src/browserGuide.ts";
import { HANDOFF_OPEN_VERBS } from "../../shared/browserHandoff.ts";
import { ACT_VERBS } from "../../shared/browserActVerbs.ts";

/* The verbs the plan names as acting (F9). The lock reads the handoff's open
   list, so each of these must be missing from it. */
const PAGE_ACT_VERBS = ACT_VERBS;

test("no acting verb is on the handoff's open list", () => {
  for (const op of PAGE_ACT_VERBS) expect(HANDOFF_OPEN_VERBS.has(op), op).toBe(false);
});

let seen: BrowserAsk[] = [];
let answer: (a: BrowserAsk) => BrowserReply = () => ({ ok: true, value: {} });
let now = Date.parse("2026-11-13T15:02:00");

beforeEach(() => {
  resetBrowserDrive();
  seen = [];
  now = Date.parse("2026-11-13T15:02:00");
  setGuideClock(() => now);
  answer = (a) => {
    if (a.op === "tabs") return { ok: true, value: [{ id: "t1", active: true }, { id: "t2", active: false }] };
    if (a.op === "point") return { ok: true, value: { name: "Rotate key", role: "button", followed: true } };
    if (a.op === "guide" && a.args.action === "next") return { ok: true, value: { event: "ok" } };
    return { ok: true, value: {} };
  };
  __setBrowserAsker(async (a) => { seen.push(a); return answer(a); });
});
afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });

async function ask(op: string, body: Record<string, unknown>): Promise<BrowserReply> {
  const p = parseAsk(op, body);
  if ("error" in p) return { ok: false, error: p.error };
  return askBrowser(p.ask);
}

const start = (as = "orbit-keys", page = "t1") => ask("guide", { action: "start", why: "Rotate the orbit-ci key", as, page });

describe("guide start", () => {
  test("marks the tab and tells the panel which one", async () => {
    const r = await start();
    expect(r.ok).toBe(true);
    expect((r.value as { tab: string }).tab).toBe("t1");
    const sent = seen.find((a) => a.op === "guide")!;
    expect(sent.args.action).toBe("start");
    expect(sent.args.page).toBe("t1");
    expect(guideCount()).toBe(1);
  });

  test("with no tab named, guides the one in front", async () => {
    const r = await ask("guide", { action: "start", why: "Rotate the key", as: "orbit-keys" });
    expect(r.ok).toBe(true);
    expect((r.value as { tab: string }).tab).toBe("t1");
  });

  test("brings a background tab to the front before it is shown", async () => {
    const r = await start("orbit-keys", "t2");
    expect(r.ok).toBe(true);
    const front = seen.findIndex((a) => a.op === "tab" && a.args.id === "t2");
    expect(front).toBeGreaterThanOrEqual(0);
    expect(front).toBeLessThan(seen.findIndex((a) => a.op === "guide"));
  });

  test("point brings its tab to the front too", async () => {
    await start("orbit-keys", "t2");
    seen = [];
    expect((await ask("point", { selector: "e14", say: "Here", as: "orbit-keys", page: "t2" })).ok).toBe(true);
    expect(seen.map((a) => a.op)).toEqual(["tab", "point"]);
  });

  test("switching to the guided tab is not an act on it; closing it still is", async () => {
    await start("orbit-keys", "t2");
    expect((await ask("tab", { id: "t2", as: "nosy" })).ok).toBe(true);
    expect((await ask("tab", { id: "t2", as: "orbit-keys" })).ok).toBe(true);
    expect((await ask("closetab", { id: "t2", as: "orbit-keys" })).ok).toBe(false);
  });

  test("a panel that cannot show it leaves no lock behind", async () => {
    answer = (a) => (a.op === "guide" ? { ok: false, error: "the person took this tab over: ask again later" } : { ok: true, value: {} });
    const r = await start();
    expect(r.ok).toBe(false);
    expect(guideCount()).toBe(0);
    expect((await ask("click", { selector: "#go", as: "orbit-keys", page: "t1" })).ok).toBe(true);
  });

  test("needs a why, one line", async () => {
    expect((await ask("guide", { action: "start", as: "a", page: "t1" })).error).toMatch(/needs why/);
    expect((await ask("guide", { action: "start", why: "a\nb", as: "a", page: "t1" })).error).toMatch(/needs why/);
    expect((await ask("guide", { action: "wander", as: "a" })).error).toMatch(/start.*next.*end/);
  });

  test("a second guide on the same tab is refused, naming the first", async () => {
    await start();
    expect((await start()).error).toMatch(/already being guided by you/);
    const other = await start("someone-else");
    expect(other.error).toMatch(/guided by orbit-keys/);
  });
});

describe("the lock", () => {
  test("every act on the guided tab is refused for the guiding agent, and never reaches the panel", async () => {
    await start();
    seen = [];
    for (const op of PAGE_ACT_VERBS) {
      const body: Record<string, unknown> = { as: "orbit-keys", page: "t1", selector: "#go", key: "Enter", text: "x", value: "x",
        fields: { "#a": "b" }, url: "https://console.acme.example/", js: "1", source: "#a", target: "#b", paths: ["/tmp/x"] };
      const p = parseAsk(op, body);
      // A verb whose body this stand-in got wrong is refused for that, not let through.
      if ("error" in p && !/guide mode/.test(p.error)) continue;
      expect("error" in p, `${op} should be refused`).toBe(true);
      expect((p as { error: string }).error).toMatch(/refused by: browser server, guide mode/);
    }
    expect(seen).toEqual([]);
  });

  test("the sentence names the layer, the guide, what to do instead and how to lift it", async () => {
    await start();
    const r = await ask("click", { selector: "role=button[name=\"Rotate key\"]", as: "orbit-keys", page: "t1" });
    expect(r.error).toBe(
      '"click" refused by: browser server, guide mode (guide start "Rotate the orbit-ci key", 15:02). '
      + "This tab is in guide mode: the person clicks, agents only point and read. "
      + 'Do this instead: point <selector> --say "…", then guide next. To act again: guide end.',
    );
  });

  test("another agent is refused too, and told whose guide it is", async () => {
    await start();
    const r = await ask("fill", { fields: { "#q": "x" }, as: "nosy", page: "t1" });
    expect(r.error).toMatch(/It is orbit-keys's guide/);
    expect(r.error).toMatch(/open --as <you>/);
  });

  test("a nameless act with no tab named is refused while a guide is on", async () => {
    await start();
    expect((await ask("click", { selector: "#go" })).error).toMatch(/guide mode/);
  });

  test("reads keep working, for everybody", async () => {
    await start();
    for (const [op, body] of [["read", {}], ["shot", {}], ["observe", {}], ["text", { selector: "#a" }]] as const) {
      expect((await ask(op, { ...body, as: "nosy", page: "t1" })).ok, op).toBe(true);
    }
  });

  test("another tab is not touched by it", async () => {
    await start();
    expect((await ask("click", { selector: "#go", as: "nosy", page: "t2" })).ok).toBe(true);
    // An agent minting its own tab is not aimed at the guided one.
    expect((await ask("open", { url: "https://orbit.example/", as: "nosy", profile: "nosy" })).ok).toBe(true);
  });

  test("read-only mode or not, the lock holds", async () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "0";
    try {
      await start();
      expect((await ask("press", { key: "Enter", as: "orbit-keys", page: "t1" })).error).toMatch(/guide mode/);
    } finally { delete process.env.AGENTGLASS_BROWSER_READONLY; }
  });

  test("survives a server restart: the lock is read back from disk", async () => {
    await start();
    resetGuides(true);
    const r = await ask("click", { selector: "#go", as: "orbit-keys", page: "t1" });
    expect(r.error).toMatch(/guide mode \(guide start "Rotate the orbit-ci key"/);
    expect((await ask("guide", { action: "end", as: "orbit-keys", page: "t1" })).ok).toBe(true);
    resetGuides(true);
    expect((await ask("click", { selector: "#go", as: "orbit-keys", page: "t1" })).ok).toBe(true);
  });

  test("lifts on guide end", async () => {
    await start();
    await ask("guide", { action: "end", as: "orbit-keys", page: "t1" });
    expect((await ask("click", { selector: "#go", as: "orbit-keys", page: "t1" })).ok).toBe(true);
  });

  test("lifts by itself after a long idle, so a dead agent cannot hold a tab", async () => {
    await start();
    now += GUIDE_IDLE_MS + 1000;
    expect((await ask("click", { selector: "#go", as: "nosy", page: "t1" })).ok).toBe(true);
  });
});

describe("point, next, end", () => {
  test("point sends the step to the panel and answers what it found", async () => {
    await start();
    const r = await ask("point", { selector: "e14", say: "Click Rotate key on the orbit-ci row.", waitClick: true, step: "2/3", as: "orbit-keys" });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ step: 1, label: "2/3", name: "Rotate key", role: "button", followed: true });
    const sent = seen.find((a) => a.op === "point")!;
    expect(sent.args).toMatchObject({ page: "t1", selector: "e14", waitClick: true, step: "2/3", n: 1 });
  });

  test("point --expect reaches the panel, and guide next passes expected through", async () => {
    await start();
    expect((await ask("point", { selector: "#plan", say: "Tick it", waitClick: true, expect: "#plan:checked", as: "orbit-keys" })).ok).toBe(true);
    expect(seen.find((a) => a.op === "point")!.args).toMatchObject({ expect: "#plan:checked" });
    answer = (a) => (a.op === "guide" ? { ok: true, value: { event: "click", expected: false } } : { ok: true, value: {} });
    expect((await ask("guide", { action: "next", as: "orbit-keys", page: "t1" })).value).toMatchObject({ event: "click", expected: false });
    expect((await ask("point", { selector: "e1", say: "x", expect: "", as: "orbit-keys" })).error).toMatch(/expect is a CSS selector/);
  });

  test("point checks its own fields", async () => {
    await start();
    expect((await ask("point", { selector: "e1", as: "orbit-keys" })).error).toMatch(/needs say/);
    expect((await ask("point", { selector: "e1", say: "x", step: "5/2", as: "orbit-keys" })).error).toMatch(/N\/M/);
  });

  test("only the guide's agent may point, wait and end", async () => {
    await start();
    for (const [op, body] of [["point", { selector: "e1", say: "x" }], ["guide", { action: "next" }], ["guide", { action: "end" }]] as const) {
      const r = await ask(op, { ...body, as: "nosy", page: "t1" });
      expect(r.error, `${op}`).toMatch(/being guided by orbit-keys/);
    }
  });

  test("next returns each event the person can give", async () => {
    for (const ev of ["ok", "back", "click", "done"]) {
      resetBrowserDrive();
      await start();
      await ask("point", { selector: "e1", say: "x", as: "orbit-keys" });
      answer = (a) => (a.op === "guide" ? { ok: true, value: { event: ev } } : { ok: true, value: {} });
      const r = await ask("guide", { action: "next", as: "orbit-keys" });
      expect(r.value).toMatchObject({ event: ev, step: 1 });
      expect(guideCount()).toBe(1);
    }
  });

  test("a click that navigates answers navigated, with where it went", async () => {
    await start();
    await ask("point", { selector: "e1", say: "Open API keys", waitClick: true, as: "orbit-keys" });
    answer = (a) => (a.op === "guide" ? { ok: true, value: { event: "navigated", url: "https://console.acme.example/keys" } } : { ok: true, value: {} });
    const r = await ask("guide", { action: "next", as: "orbit-keys" });
    expect(r.value).toMatchObject({ event: "navigated", navigated: true, url: "https://console.acme.example/keys" });
  });

  test("no answer yet is pending, never a guess", async () => {
    await start();
    answer = (a) => (a.op === "guide" ? { ok: true, value: { event: null } } : { ok: true, value: {} });
    const r = await ask("guide", { action: "next", as: "orbit-keys", waitMs: 50 });
    expect(r.value).toMatchObject({ pending: true });
  });

  test("Stop ends the guide, and guide end still returns the audit", async () => {
    await start();
    await ask("point", { selector: "e1", say: "x", as: "orbit-keys" });
    answer = (a) => (a.op === "guide" ? { ok: true, value: { event: "stop" } } : { ok: true, value: {} });
    const r = await ask("guide", { action: "next", as: "orbit-keys" });
    expect(r.value).toMatchObject({ event: "stop", ended: true });
    expect(guideCount()).toBe(0);
    expect((await ask("click", { selector: "#go", as: "orbit-keys", page: "t1" })).ok).toBe(true);
    const again = await ask("guide", { action: "next", as: "orbit-keys" });
    expect(again.error).toMatch(/pressed Stop/);
    const end = await ask("guide", { action: "end", as: "orbit-keys" });
    expect(end.value).toMatchObject({ endedBy: "stop" });
  });

  test("a closed tab and a Take over end the guide", async () => {
    for (const [error, by] of [["no tab called t1", "closed"], ["the person took this tab over: ask again later", "takeover"]] as const) {
      resetBrowserDrive();
      await start();
      answer = (a) => (a.op === "guide" ? { ok: false, error } : { ok: true, value: {} });
      expect((await ask("guide", { action: "next", as: "orbit-keys" })).ok).toBe(false);
      expect(guideCount()).toBe(0);
      answer = () => ({ ok: true, value: {} });
      expect((await ask("guide", { action: "end", as: "orbit-keys" })).value).toMatchObject({ endedBy: by });
    }
  });

  test("guide end returns every step, what the person did, and the refused acts", async () => {
    await start();
    await ask("point", { selector: "role=link[name=\"API keys\"]", say: "Open API keys", step: "1/2", as: "orbit-keys" });
    now += 25_000;
    await ask("guide", { action: "next", as: "orbit-keys" });
    await ask("click", { selector: "#rotate", as: "orbit-keys", page: "t1" });
    await ask("point", { selector: "e14", say: "Click Rotate key", waitClick: true, as: "orbit-keys" });
    answer = (a) => (a.op === "guide" ? { ok: true, value: { event: "click" } } : a.op === "point" ? { ok: true, value: { name: "Rotate key", role: "button" } } : { ok: true, value: {} });
    now += 60_000;
    await ask("guide", { action: "next", as: "orbit-keys" });
    seen = [];
    const r = await ask("guide", { action: "end", as: "orbit-keys" });
    expect(seen.map((a) => [a.op, a.args.action])).toEqual([["guide", "end"]]);
    const v = r.value as Record<string, unknown> & { steps: Array<Record<string, unknown>> };
    expect(v).toMatchObject({ why: "Rotate the orbit-ci key", tab: "t1", endedBy: "agent", seconds: 85, agentActs: 0, refusedCount: 1 });
    expect(v.steps.map((s) => s.did)).toEqual(["pressed OK", "clicked Rotate key, button"]);
    expect(v.steps[0]).toMatchObject({ n: 1, label: "1/2", target: "role=link[name=\"API keys\"]" });
    expect((v.refused as Array<{ op: string }>)[0]!.op).toBe("click");
    expect(guideCount()).toBe(0);
  });

  test("with no guide on, the verbs say how to start one", async () => {
    expect((await ask("point", { selector: "e1", say: "x", as: "orbit-keys" })).error).toMatch(/guide start/);
    expect((await ask("guide", { action: "next", as: "orbit-keys" })).error).toMatch(/guide start/);
  });
});

describe("guide events to the panel", () => {
  test("start, point, wait and end each carry a guide activity", async () => {
    await start();
    await ask("point", { selector: "e3", say: "Look at the key list.", as: "orbit-keys" });
    await ask("point", { selector: "e14", say: "Click Rotate key.", waitClick: true, step: "2/3", as: "orbit-keys" });
    await ask("guide", { action: "end", as: "orbit-keys" });
    const acts = seen.filter((a) => a.op === "guide" || a.op === "point").map((a) => a.args.activity);
    expect(acts).toEqual([
      { kind: "guide", tab: "t1", phase: "start", say: "Rotate the orbit-ci key", agent: "orbit-keys" },
      { kind: "guide", tab: "t1", phase: "point", say: "Look at the key list.", waitClick: false },
      { kind: "guide", tab: "t1", phase: "wait", step: { n: 2, m: 3 }, say: "Click Rotate key.", waitClick: true },
      { kind: "guide", tab: "t1", phase: "end" },
    ]);
  });

  test("a click that navigates: guide next answers navigated with the url", async () => {
    await start();
    await ask("point", { selector: "e9", say: "Open Settings.", waitClick: true, as: "orbit-keys" });
    answer = (a) => (a.op === "guide" && a.args.action === "next" ? { ok: true, value: { event: "navigated", url: "http://127.0.0.1/settings" } } : { ok: true, value: {} });
    const r = await ask("guide", { action: "next", as: "orbit-keys" });
    expect(r.value).toMatchObject({ event: "navigated", navigated: true, url: "http://127.0.0.1/settings" });
  });
});
