import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { watchPayload, type AskedAlert } from "../../shared/notifyPayload.ts";

/*
 * What the person asked for waits for them. The store is tested for the three
 * rules (max three drawn, not raised again once closed, closing tells the
 * server), and the component is held to its placement as a rule about source:
 * there is no renderer here, so "top centre, not over the usage indicator, no
 * timer" is asserted against the text, comments stripped first.
 */
const stubGlobal = globalStubs();
const calls: { url: string; body: unknown }[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify({ ok: true, open: [], audit: [] }), { headers: { "content-type": "application/json" } });
});

let B: typeof import("../src/lib/askedBanners.ts");
beforeAll(async () => { B = await import("../src/lib/askedBanners.ts"); });
const flush = () => Bun.sleep(20); // the api layer sends a tick later
beforeEach(async () => { await flush(); B.__resetAskedBanners(); await flush(); calls.length = 0; });

const alert = (n: number, over: Partial<AskedAlert> = {}): AskedAlert => ({
  id: `a${n}`, key: `acme/orbit#${n}@abc:pass`, ok: true,
  payload: watchPayload({ repo: "acme/orbit", number: n, title: "ORBIT-1042 add thing", summary: "CI passed", detail: "" }),
  firedAt: 1000 + n, seenAt: null, actedAt: null, closedAt: null, osError: null, ...over,
});
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the store", () => {
  it("draws at most three, newest first, and folds the rest into +N", () => {
    const { shown, more } = B.layoutBanners([1, 2, 3, 4, 5].map((n) => alert(n)));
    expect(shown.map((a) => a.id)).toEqual(["a5", "a4", "a3"]);
    expect(more).toBe(2);
    expect(B.MAX_SHOWN).toBe(3);
  });
  it("an older one comes back out as a newer one is answered", () => {
    for (const n of [1, 2, 3, 4]) B.showAsked(alert(n));
    expect(B.layoutBanners(B.askedNow()).shown.map((a) => a.id)).toEqual(["a4", "a3", "a2"]);
    B.closeAsked("a4", false);
    expect(B.layoutBanners(B.askedNow()).shown.map((a) => a.id)).toEqual(["a3", "a2", "a1"]);
    expect(B.layoutBanners(B.askedNow()).more).toBe(0);
  });
  it("is not raised twice by id or by key, and not again after it was closed", async () => {
    B.showAsked(alert(1)); B.showAsked(alert(1));
    B.showAsked(alert(1, { id: "other-window" })); // same event, another id
    B.closeAsked("a1", false);
    B.showAsked(alert(1)); B.showAsked(alert(1, { id: "later" }));
    expect(B.askedNow()).toHaveLength(0);
    await flush();
    expect(calls.filter((c) => c.url.endsWith("/alerts/asked/seen"))).toHaveLength(1);
  });
  it("closing says whether it was acted on, to the server, which closes it everywhere", async () => {
    B.showAsked(alert(2));
    B.closeAsked("a2", true);
    await flush();
    expect(calls.find((c) => c.url.endsWith("/alerts/asked/close"))!.body).toEqual({ id: "a2", acted: true });
  });
  it("closed elsewhere takes it down without telling the server again", async () => {
    B.showAsked(alert(3)); await flush(); calls.length = 0;
    B.closedElsewhere("a3");
    B.showAsked(alert(3));
    await flush();
    expect(B.askedNow()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("the banner", () => {
  const src = await_(new URL("../src/components/AskedBanners.tsx", import.meta.url));
  it("sits top centre under the bar, never at the top right where the usage indicator is", () => {
    const s = strip(src);
    expect(s).toContain("top: TOP_BAR_H + 10");
    expect(s).toContain('left: "50%"');
    expect(s).toContain("translateX(-50%)");
    expect(s).not.toMatch(/\bright:/);
  });
  it("is not modal: the wrapper takes no pointer events and the banners do", () => {
    const s = strip(src);
    expect(s).toContain('pointerEvents: "none"');
    expect(s).toContain('pointerEvents: "auto"');
    expect(s).not.toMatch(/inset: 0|backdrop|bg-black/);
  });
  it("waits for the person: no timer anywhere, Escape and the × close it, the action acts", () => {
    const s = strip(src);
    expect(s).not.toMatch(/setTimeout|setInterval/);
    expect(s).toContain('e.key === "Escape"');
    expect(s).toContain("closeAsked(a.id, false)");
    expect(s).toContain("closeAsked(a.id, true); openTarget(");
  });
  it("draws at most the layout's three", () => {
    expect(strip(src)).toContain("layoutBanners(list)");
  });
  it("is the card: rail, round icon, verdict word in its ink, facts, a primary and one secondary, the +N pill", () => {
    const s = strip(src);
    expect(s).toContain("width: 6"); // the rail
    expect(s).toContain("borderRadius: \"0 4px 4px 0\"");
    expect(s).toContain("<span style={{ color: ink }}>{verdict}</span>{object}");
    expect(s).toContain("a.payload.facts");
    expect(s).toContain("primaryAction(a.payload)");
    expect(s).toContain("secondaryAction(a.payload)");
    expect(s).toContain("more alert");
    expect(s).toContain("min(620px");
  });
  it("only the newest is a full card: the older ones fold to one compact row so the stack stays short", () => {
    const s = strip(src);
    expect(s).toContain("i === 0 ? <Banner");
    expect(s).toContain(": <Row key={a.id}");
    expect(s).toContain("const ROW_H = 36;");
    expect(s).toContain("height: ROW_H");
    // the row keeps what is needed to act and nothing else: no facts, no secondary, no line
    const row = s.slice(s.indexOf("function Row("), s.indexOf("function Banner("));
    expect(row).toContain("closeAsked(a.id, true); openTarget(to)");
    expect(row).not.toMatch(/facts|secondaryAction|payload\.line/);
  });
  it("is drawn in house tokens only: no literal colour, theme-aware, close and icon from the house sizes", () => {
    const s = strip(src);
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/rgba?\(/);
    for (const t of ["var(--success)", "var(--error)", "var(--success-ink)", "var(--error-ink)", "var(--surface-card)", "EDGE"]) expect(s).toContain(t);
    expect(s).toContain('background: ink, color: "var(--bg)"'); // contrast measured on every theme: see the component
    expect(s).toContain("ICON.lg");
    expect(s).toContain("HIT");
    expect(s).toContain("<CloseButton");
  });
  it("the re-run is a deed that reports its failure on the card instead of closing it", () => {
    const s = strip(src);
    expect(s).toContain("api.prRerun(x.root, x.number)");
    expect(s).toContain("if (r.ok) closeAsked(a.id, true);");
    expect(s).toContain("setErr(");
  });
  it("is mounted once, in the app shell", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(app.match(/<AskedBanners \/>/g)).toHaveLength(1);
  });
});

function await_(u: URL): string { return require("node:fs").readFileSync(u, "utf8"); }
