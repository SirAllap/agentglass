/*
 * Lanes as the relay sees them: a table, a cap, an idle clock, and a refusal
 * for a lane that is not there.
 *
 * No sockets: the window that makes a host and the host itself are stood in for
 * by the sink, which answers the manager's ask and then registers the lane's
 * host the way a real one does, a beat later.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  askBrowser, exportAudit, noteBrowserManager, noteBrowserReady, parseAsk, resetBrowserDrive, setBrowserSink,
  settleBrowser, type BrowserAsk,
} from "../src/browserdrive.ts";
import { LANE_IDLE_MS, MAX_LANES, listLanes, setHostWaitForTest, sweepLanes } from "../src/lanes.ts";

let sent: Array<{ to: string; op: string; args: Record<string, unknown> }> = [];
/** When false the manager acknowledges but no host ever registers. */
let hostsCome = true;
/** When true a host takes an ask and never answers it. */
let mute = false;

beforeEach(() => {
  resetBrowserDrive();
  sent = [];
  hostsCome = true;
  mute = false;
  setBrowserSink({
    send: (a, to) => {
      sent.push({ to, op: a.op, args: a.args });
      if (mute && a.op !== "lane") return;
      queueMicrotask(() => {
        settleBrowser(a.id, { ok: true, value: a.op === "lane" ? "done" : "page" });
        const make = a.args.make;
        if (a.op === "lane" && typeof make === "string" && hostsCome) noteBrowserReady(`host-${make}`, true, [make]);
      });
    },
    listeners: () => 1,
    live: () => true,
  });
  noteBrowserManager("mgr", true);
});
afterEach(() => resetBrowserDrive());

const run = (op: string, body: Record<string, unknown>) => {
  const p = parseAsk(op, { as: "orbit", ...body });
  if ("error" in p) throw new Error(p.error);
  return askBrowser(p.ask as BrowserAsk);
};
const open = async (body: Record<string, unknown> = {}) => {
  const r = await run("lane", { action: "new", ...body });
  expect(r.ok).toBe(true);
  return (r.value as { lane: { id: string } }).lane.id;
};

describe("lane new / list / close", () => {
  test("new asks the manager, waits for the host, and is listed with its owner", async () => {
    const id = await open();
    expect(sent[0]).toMatchObject({ to: "mgr", op: "lane", args: { make: id, container: "private" } });
    const listed = await run("lane", { action: "list" });
    expect((listed.value as { lanes: Array<{ id: string; as: string }> }).lanes).toMatchObject([{ id, as: "orbit" }]);
  });

  test("private is the default; shared and a named container are asked for by name", async () => {
    await open({ shared: true });
    await open({ profile: "orbit-qa" });
    expect(sent.filter((s) => "make" in s.args).map((s) => [s.args.container, s.args.name])).toEqual([["shared", undefined], ["named", "orbit-qa"]]);
    expect("error" in parseAsk("lane", { action: "new", profile: "a\nb" })).toBe(true);
  });

  test("it needs no Browser panel: only the manager", async () => {
    // Nothing but the manager is registered at this point; a panel-less app opens a lane.
    expect(await open()).toMatch(/^l[0-9a-f]{8}$/);
  });

  test("with no manager it says so instead of timing out", async () => {
    noteBrowserManager("mgr", false);
    const r = await run("lane", { action: "new" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not open");
  });

  test("a host that never comes up is torn down and the slot is given back", async () => {
    hostsCome = false;
    setHostWaitForTest(150);
    const r = await run("lane", { action: "new" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not come up");
    expect(listLanes()).toHaveLength(0);
    expect(sent.at(-1)?.args).toHaveProperty("drop");
  });

  test(`the ${MAX_LANES + 1}th lane is refused, and closing one frees the slot`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_LANES; i++) ids.push(await open());
    const over = await run("lane", { action: "new" });
    expect(over.ok).toBe(false);
    expect(over.error).toContain("cap");
    expect((await run("lane", { action: "close", id: ids[0] })).ok).toBe(true);
    expect(await open()).toBeTruthy();
  });

  test("close destroys the host and forgets its registration", async () => {
    const id = await open();
    expect((await run("lane", { action: "close", id })).ok).toBe(true);
    expect(sent.at(-1)).toMatchObject({ to: "mgr", args: { drop: id } });
    expect(listLanes()).toHaveLength(0);
    const again = await run("lane", { action: "close", id });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("no lane called");
  });
});

describe("an ask addressed to a lane", () => {
  test("reaches that lane's host only, and the person's window never sees it", async () => {
    noteBrowserReady("visible", true);
    const a = await open();
    const b = await open();
    sent = [];
    await run("read", { lane: a });
    await run("read", { lane: b });
    await run("read", {});
    expect(sent.map((s) => s.to)).toEqual([`host-${a}`, `host-${b}`, "visible"]);
  });

  test("a lane that is not in the table is a named refusal, never the visible tab", async () => {
    noteBrowserReady("visible", true);
    const r = await run("read", { lane: "l-gone" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no lane called l-gone");
    expect(sent).toHaveLength(0);
  });

  test("a lane closed under an agent refuses the same way", async () => {
    noteBrowserReady("visible", true);
    const id = await open();
    await run("lane", { action: "close", id });
    sent = [];
    const r = await run("click", { lane: id, selector: "#go" });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("the audit row carries the lane", async () => {
    const id = await open();
    await run("read", { lane: id });
    const rows = exportAudit().filter((e) => e.op === "read");
    expect(rows.at(-1)?.lane).toBe(id);
  });

  test("closing a lane settles what its host was asked, at once", async () => {
    const id = await open();
    mute = true;
    const pending = run("read", { lane: id });
    await Bun.sleep(10);
    await run("lane", { action: "close", id });
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("closed before answering");
  });

  test("an observation from a lane says which lane, so a hidden page there is not an alarm", async () => {
    const id = await open();
    const seenValue = { visible: false, title: "t" };
    setBrowserSink({
      send: (a) => queueMicrotask(() => settleBrowser(a.id, { ok: true, value: { ...seenValue } })),
      listeners: () => 1, live: () => true,
    });
    const inLane = await run("observe", { lane: id });
    expect((inLane.value as Record<string, unknown>).lane).toBe(id);
    expect((inLane.value as Record<string, unknown>).visible).toBe(false);
    noteBrowserReady("visible", true);
    const plain = await run("observe", {});
    expect((plain.value as Record<string, unknown>).lane).toBeUndefined();
  });

  test("a malformed lane is refused at the door", () => {
    const p = parseAsk("read", { lane: "../etc" });
    expect("error" in p).toBe(true);
  });
});

describe("whose lane it is", () => {
  test("only the agent that opened a lane may drive, list or close it, unless forced", async () => {
    const id = await open();   // opened as orbit
    sent.length = 0;
    const other = (op: string, body: Record<string, unknown>) => run(op, { ...body, as: "acme" });
    const read = await other("read", { lane: id });
    expect(read.ok).toBe(false);
    expect(read.error).toContain("was opened by orbit");
    expect(sent).toHaveLength(0);
    expect((await other("lane", { action: "close", id })).error).toContain("was opened by orbit");
    expect(listLanes()).toHaveLength(1);
    const theirs = await other("lane", { action: "list" });
    expect((theirs.value as { lanes: unknown[] }).lanes).toHaveLength(0);
    const all = await other("lane", { action: "list", force: true });
    expect((all.value as { lanes: unknown[] }).lanes).toHaveLength(1);
    // A caller that names nobody cannot be told from the MCP with no identity: allowed, like a tab.
    expect((await run("read", { lane: id, as: undefined })).ok).toBe(true);
    expect((await other("lane", { action: "close", id, force: true })).ok).toBe(true);
  });
});

describe("read-only mode", () => {
  test("making a lane is not an act, closing one is", () => {
    const acts = (body: Record<string, unknown>) => {
      const p = parseAsk("lane", { as: "orbit", ...body });
      if ("error" in p) throw new Error(p.error);
      return p.ask.args.acts;
    };
    expect(acts({ action: "new" })).toBe(false);
    expect(acts({ action: "list" })).toBe(false);
    expect(acts({ action: "close", id: "l1a2b3c4d" })).toBe(true);
  });
});

describe("the clock", () => {
  test("an idle lane is closed; one that was used is not", async () => {
    const idle = await open();
    const busy = await open();
    await Bun.sleep(30);
    await run("read", { lane: busy });
    const used = listLanes().find((l) => l.id === busy)!.lastAsk;
    await sweepLanes(used + LANE_IDLE_MS);   // exactly as idle as the limit allows, for the one that was used
    expect(listLanes().map((l) => l.id)).toEqual([busy]);
    await sweepLanes(used + LANE_IDLE_MS + 1);
    expect(listLanes()).toHaveLength(0);
    expect(sent.filter((s) => "drop" in s.args).map((s) => s.args.drop).sort()).toEqual([idle, busy].sort());
  });

  test("a lane that lost its host is dropped after a minute, not at once", async () => {
    const id = await open();
    noteBrowserReady(`host-${id}`, false);
    await sweepLanes(Date.now());
    expect(listLanes()).toHaveLength(1);
    await sweepLanes(Date.now() + 61_000);
    expect(listLanes()).toHaveLength(0);
  });
});
