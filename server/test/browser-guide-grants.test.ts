/*
 * A worker guiding the person on their own tab, under a guide grant.
 *
 * A grant names one agent and one site and ends after two hours or with the
 * agent's session. These drive the real gate (`agentAskRefusal`, what the
 * relay route runs for a worker credential) and the real door (`parseAsk`
 * then `askBrowser`, with the ask filed under the worker as the route files
 * it) against a stand-in panel whose tab list says which site each tab is on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __setBrowserAsker, agentAskRefusal, askBrowser, forgetWorkerPages, noteWorkerAsk, parseAsk, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { finishGuide, guideCount, guideOf, setGuideClock } from "../src/browserGuide.ts";
import { GUIDE_GRANT_MS, GUIDE_GRANTS_PLACE, addGuideGrant, listGuideGrants } from "../src/browserGuideGrants.ts";

const A = "orbit-a";
const B = "orbit-b";
const SITE = "https://news.example.com";
let now = Date.parse("2026-11-13T15:02:00");
let seen: BrowserAsk[] = [];
let t1Url = `${SITE}/item?id=1042`;

beforeEach(() => {
  resetBrowserDrive();
  seen = [];
  now = Date.parse("2026-11-13T15:02:00");
  t1Url = `${SITE}/item?id=1042`;
  setGuideClock(() => now);
  __setBrowserAsker(async (a) => {
    seen.push(a);
    if (a.op === "tabs") {
      return { ok: true, value: [
        { id: "t1", active: true, url: t1Url, profile: "" },
        { id: "t2", active: false, url: "https://other.example.org/", profile: "" },
      ] };
    }
    if (a.op === "point") return { ok: true, value: { name: "Submit", role: "button", followed: true } };
    if (a.op === "guide" && a.args.action === "next") return { ok: true, value: { event: "ok" } };
    if (a.op === "read") return { ok: true, value: { text: "the page" } };
    return { ok: true, value: {} };
  });
});
afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });

/** A worker's ask as the CLI sends `--shared --page <tab>`: its own name, the tab it typed. */
const body = (as: string, extra: Record<string, unknown>) => ({ as, shared: true, how: "explicit-page", pageExplicit: true, ...extra });

/** The route, in order: the gate, then the door with the ask filed under the worker. */
async function workerAsk(as: string, op: string, extra: Record<string, unknown>): Promise<BrowserReply> {
  const b = body(as, extra);
  const refused = agentAskRefusal(b, as, op);
  if (refused) return { ok: false, error: refused };
  const p = parseAsk(op, b);
  if ("error" in p) return { ok: false, error: p.error };
  noteWorkerAsk(p.ask.id, as, p.ask.op);
  return askBrowser(p.ask);
}
const start = (as = A, page = "t1") => workerAsk(as, "guide", { action: "start", why: "Post the launch note", page });

describe("no grant", () => {
  test("guide start is refused and names the place that grants it", async () => {
    const r = await start();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`no guide grant for ${A}`);
    expect(r.error).toContain(GUIDE_GRANTS_PLACE);
    expect(guideCount()).toBe(0);
  });

  test("point and a read of the person's tab are refused, naming the place", async () => {
    for (const [op, extra] of [["point", { selector: "e3", say: "Here", page: "t1" }], ["read", { page: "t1" }]] as const) {
      const r = await workerAsk(A, op, extra);
      expect(r.ok, op).toBe(false);
      expect(r.error, op).toContain(GUIDE_GRANTS_PLACE);
    }
  });

  test("the MCP's `shared: true` spelling is refused the same way", () => {
    const why = agentAskRefusal({ as: A, shared: true, page: "t1", action: "start", why: "x" }, A, "guide");
    expect(why).toContain(GUIDE_GRANTS_PLACE);
  });
});

describe("with a grant for this agent on this site", () => {
  beforeEach(() => { expect("grant" in addGuideGrant(A, SITE)).toBe(true); });

  test("guide start, point, next and end all run", async () => {
    const s = await start();
    expect(s.ok).toBe(true);
    expect((await workerAsk(A, "point", { selector: "e3", say: "Press Submit", page: "t1" })).ok).toBe(true);
    expect((await workerAsk(A, "guide", { action: "next", page: "t1" })).ok).toBe(true);
    const end = await workerAsk(A, "guide", { action: "end", page: "t1" });
    expect(end.ok).toBe(true);
    expect(guideCount()).toBe(0);
  });

  test("guide start names the worker in the panel", async () => {
    await start();
    const sent = seen.find((a) => a.op === "guide" && a.args.action === "start")!;
    expect((sent.args.activity as { agent?: string }).agent).toBe(A);
  });

  test("click, fill and open on the person's tab stay refused, during a guide too", async () => {
    await start();
    for (const [op, extra] of [
      ["click", { selector: "e3", page: "t1" }],
      ["fill", { fields: { e4: "x" }, page: "t1" }],
      ["open", { url: `${SITE}/submit`, page: "t1" }],
    ] as const) {
      const r = await workerAsk(A, op, extra);
      expect(r.ok, op).toBe(false);
      expect(seen.some((a) => a.op === op), op).toBe(false);
    }
    const shared = agentAskRefusal({ as: A, shared: true, page: "t1", selector: "e3" }, A, "click");
    expect(shared).toContain("only guides and reads");
  });

  test("a read with no guide running is refused and says guide start first", async () => {
    const r = await workerAsk(A, "read", { page: "t1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("guide start");
    expect(seen.some((a) => a.op === "read")).toBe(false);
  });

  test("a read during its own guide runs", async () => {
    await start();
    const r = await workerAsk(A, "read", { page: "t1" });
    expect(r.ok).toBe(true);
    expect(seen.some((a) => a.op === "read" && a.args.page === "t1")).toBe(true);
  });

  test("the guide ends between the gate and the serve: the read is refused", async () => {
    await start();
    const b = body(A, { page: "t1" });
    expect(agentAskRefusal(b, A, "read")).toBeNull();
    const p = parseAsk("read", b);
    if ("error" in p) throw new Error(p.error);
    noteWorkerAsk(p.ask.id, A, p.ask.op);
    /* The person presses Stop after the gate let the ask through. */
    finishGuide(guideOf("t1")!, "stop");
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('guide start "<why>" --shared first');
    expect(seen.some((a) => a.op === "read")).toBe(false);
  });

  test("the guide ends while the tab list is asked: the read is refused", async () => {
    await start();
    __setBrowserAsker(async (a) => {
      seen.push(a);
      if (a.op === "tabs") {
        const g = guideOf("t1");
        if (g) finishGuide(g, "stop");
        return { ok: true, value: [{ id: "t1", active: true, url: t1Url, profile: "" }] };
      }
      return { ok: true, value: { text: "the page" } };
    });
    const r = await workerAsk(A, "read", { page: "t1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no guide of yours runs on t1 now");
    expect(seen.some((a) => a.op === "read")).toBe(false);
  });

  test("guide start --shared with no --page takes the person's tab in front and names it", async () => {
    const b = { as: A, shared: true, how: "shared", action: "start", why: "Post the launch note" };
    expect(agentAskRefusal(b, A, "guide")).toBeNull();
    const p = parseAsk("guide", b);
    if ("error" in p) throw new Error(p.error);
    noteWorkerAsk(p.ask.id, A, p.ask.op);
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(true);
    expect((r.value as { tab?: string }).tab).toBe("t1");
    expect(guideOf("t1")?.as).toBe(A);
  });

  test("guide start --shared with no --page still checks the grant on the tab in front", async () => {
    t1Url = "https://other.example.org/elsewhere";
    const b = { as: A, shared: true, how: "shared", action: "start", why: "Post the launch note" };
    const p = parseAsk("guide", b);
    if ("error" in p) throw new Error(p.error);
    noteWorkerAsk(p.ask.id, A, p.ask.op);
    const r = await askBrowser(p.ask);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no guide grant for orbit-a on https://other.example.org");
    expect(guideCount()).toBe(0);
  });

  test("tabs lists the guided tab and no other of the person's", async () => {
    await start();
    const r = await workerAsk(A, "tabs", {});
    expect(r.ok).toBe(true);
    expect((r.value as Array<{ id: string }>).map((t) => t.id)).toEqual(["t1"]);
  });

  test("a grant for agent A does not let agent B", async () => {
    /* B holds a grant of its own, on another site: only A's covers this one. */
    expect("grant" in addGuideGrant(B, "https://other.example.org")).toBe(true);
    const r = await start(B);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`no guide grant for ${B} on ${SITE}`);
  });

  test("a grant for site X does not let a tab on site Y", async () => {
    const r = await start(A, "t2");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no guide grant for orbit-a on https://other.example.org");
    expect(guideCount()).toBe(0);
  });

  test("an expired grant is refused", async () => {
    now += GUIDE_GRANT_MS + 1;
    expect(listGuideGrants()).toEqual([]);
    const r = await start();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(GUIDE_GRANTS_PLACE);
  });

  test("navigating away ends the guide and refuses the read", async () => {
    await start();
    t1Url = "https://other.example.org/elsewhere";
    const r = await workerAsk(A, "read", { page: "t1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("on https://other.example.org");
    expect(r.error).toContain("The guide has ended");
    expect(guideCount()).toBe(0);
    expect(seen.some((a) => a.op === "read")).toBe(false);
  });

  test("the agent's session ending ends its grant", async () => {
    forgetWorkerPages(A);
    expect(listGuideGrants()).toEqual([]);
    expect((await start()).ok).toBe(false);
  });
});
