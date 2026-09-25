/*
 * A lane host is the same bundle in a window nobody sees, mounting one webview
 * for an agent. Two decisions live on this side: which windows are lanes, and
 * that a lane never serves an ask aimed at a tab it does not have.
 */
import { describe, expect, test } from "bun:test";
import { laneSlug } from "../src/lib/laneManager.ts";
import { lanesLabel } from "../src/components/LanesRow.tsx";
import { laneFromHash, laneProfileFromHash } from "../src/lib/lane.ts";

const HOST = await Bun.file(new URL("../src/components/LaneHost.tsx", import.meta.url)).text();
const BUS = await Bun.file(new URL("../src/lib/browserBus.ts", import.meta.url)).text();
const MANAGER = await Bun.file(new URL("../src/lib/laneManager.ts", import.meta.url)).text();
const PANEL = await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text();
const MAIN = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("laneFromHash", () => {
  test("reads the id of a lane window", () => {
    expect(laneFromHash("#lane=spike")).toBe("spike");
    expect(laneFromHash("#lane=a_1-B")).toBe("a_1-B");
  });

  test("a lane may name its container after &p=, and no name is the person's own", () => {
    expect(laneFromHash("#lane=l1a2b3c4d&p=l1a2b3c4d")).toBe("l1a2b3c4d");
    expect(laneProfileFromHash("#lane=l1a2b3c4d&p=l1a2b3c4d")).toBe("l1a2b3c4d");
    expect(laneProfileFromHash("#lane=spike")).toBe("");
    expect(laneProfileFromHash("#lane=a&p=../x")).toBe("");
    expect(laneFromHash("#lane=a&p=../x")).toBeNull();
  });

  test("anything else is the app, not a lane", () => {
    for (const h of ["", "#", "#lane=", "#lane=a b", "#lane=x&y=1", "#other=spike", "#lane=../x", `#lane=${"a".repeat(65)}`]) {
      expect(laneFromHash(h)).toBeNull();
    }
  });
});

describe("the lane host page", () => {
  test("main.tsx mounts it before the app when the hash names a lane", () => {
    const at = code(MAIN);
    expect(at).toContain("const lane = laneFromHash(location.hash);");
    expect(at).toContain("if (lane) {\n  mount(<LaneHost id={lane} profile={laneProfileFromHash(location.hash)} />);\n} else if (invitation) {");
    expect(at.indexOf("mount(<LaneHost id={lane}")).toBeLessThan(at.indexOf("<PairScreen"));
  });

  test("an ask naming another tab is refused, never served from the lane's webview", () => {
    const at = code(HOST);
    const refuse = at.indexOf("if (typeof page === \"string\" && page !== tab)");
    expect(refuse).toBeGreaterThan(-1);
    const serve = at.indexOf("serveBrowserAsk(el(), ask)");
    expect(serve).toBeGreaterThan(refuse);
    expect(at.slice(refuse, serve)).toContain("ok: false");
    expect(at.slice(refuse, serve)).toContain("return;");
  });

  test("open stays in the lane's one container and on http(s)", () => {
    const at = code(HOST);
    expect(at).toContain('if (asked && asked !== "default") return { error:');
    // The refusal of another tab must carry the window's name, or the server drops it and the ask hangs.
    expect(at).toContain("api.browserResult({ client: clientId(), id: ask.id, ok: false,");
    expect(at).toContain("partition={partitionFor(BROWSER_PARTITION, profile)}");
    expect(at).toContain("const to = !url || url === BLANK ? BLANK : normalizeNavigationUrl(url);");
    expect(at).toContain('if (!to) return { error:');
    expect(at).toContain("loadURL(to)");
  });

  test("it registers as a window that can answer, and unregisters", () => {
    const at = code(HOST);
    // As the host of its own lane: with no lane it would be the main window's role.
    expect(at).toContain("api.browserReady(me, true, [id])");
    expect(at).toContain("api.browserReady(me, false, [id])");
    expect(at).toContain("setBrowserAskHandler(null)");
  });
});

describe("the app window as the lane manager", () => {
  test("a lane's container is a private jar by default, the person's on request, a named one only if it exists", () => {
    const profiles = [{ id: "orbit1", name: "orbit-qa" }];
    expect(laneSlug("l1a2b3c4d", "private", undefined, profiles)).toEqual({ slug: "l1a2b3c4d" });
    expect(laneSlug("l1a2b3c4d", "shared", undefined, profiles)).toEqual({ slug: "" });
    expect(laneSlug("l1a2b3c4d", "named", "orbit-qa", profiles)).toEqual({ slug: "orbit1" });
    expect("error" in laneSlug("l1a2b3c4d", "named", "nobody", profiles)).toBe(true);
    // Never quietly the person's jar for something it did not recognise.
    expect("error" in laneSlug("l1a2b3c4d", "named", undefined, profiles)).toBe(true);
    expect(laneSlug("l1a2b3c4d", "surprise", undefined, profiles)).toEqual({ slug: "l1a2b3c4d" });
  });

  test("a lane ask is the app's, panel or no panel, and an unhandled one is answered", () => {
    const bus = code(BUS);
    const at = bus.indexOf('if (ask.op === "lane") {');
    expect(at).toBeGreaterThan(-1);
    const end = bus.indexOf("if (handler) handler(ask);", at);
    expect(end).toBeGreaterThan(at);
    expect(bus.slice(at, end)).toContain("laneHandler(ask)");
    expect(bus.slice(at, end)).toContain("api.browserResult");
    expect(bus.slice(at, end)).toContain("return;");
  });

  test("the app registers as the manager while it is up, on a heartbeat, and says goodbye", () => {
    const at = code(MANAGER);
    expect(at).toContain("api.browserManager(me, true)");
    expect(at).toContain("api.browserManager(me, false)");
    expect(at).toContain("setLaneAskHandler(null)");
    // The server's own list comes back on every heartbeat and the app drops what it does not name.
    expect(at).toContain("keepLaneWindows(r.lanes)");
    expect(at).toContain("if (!CAN_MAKE_LANES) return;");
  });

  test("the Browser sidebar carries the quiet row, and the row says who, not which", () => {
    expect(code(PANEL)).toContain("<LanesRow />");
    expect(lanesLabel([])).toBeNull();
    const row = { id: "l1", container: "private" as const, created: 0, lastAsk: 0 };
    expect(lanesLabel([{ ...row, as: "orbit" }, { ...row, id: "l2", as: "orbit" }, { ...row, id: "l3", as: "acme" }])).toBe("3 lanes · orbit, acme");
    expect(lanesLabel([row])).toBe("1 lane · an agent");
    expect(lanesLabel([row])).not.toContain("l1");
  });
});
