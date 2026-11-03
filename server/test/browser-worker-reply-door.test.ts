/*
 * A WORKER'S REPLY IS SCOPED AT THE DOOR, NOT BY THE ROUTE.
 *
 * The window answers `tabs` with the whole list, and `tab`, `closetab`, `open`
 * and `newtab` fold the same list into theirs. Scoping by verb at the scalar
 * route left every other container — `do` steps, `lanes`, the `whoami`
 * composition — handing a worker the person's tab and another agent's page.
 * So `askBrowser` is the one door, and these drive the real functions a route
 * calls: `runSteps`, `runLanes`, and `askBrowser` itself.
 *
 * The tab answers are built by the panel's own builders, not typed here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setBrowserAsker, askBrowser, noteBrowserReady, noteWorkerAsk, noteWorkerPage, parseAsk, resetBrowserDrive, runLanes, runSteps,
  setBrowserSink, settleBrowser, workerAskCount, workerOwnsPage,
} from "../src/browserdrive.ts";
import { configureLanes, openLane } from "../src/lanes.ts";
import { closedReply, openedReply, selectedReply, tabsReply, type TabRow } from "../../shared/browserTabReplies.ts";
import { agentContainerName } from "../../shared/workerContainer.ts";

const OWN = "orbit-1";
const MINE: TabRow = { id: "t9-own", profile: agentContainerName(OWN), title: "Orbit", url: "https://orbit.example/", active: false };
const PERSON: TabRow = {
  id: "t9-person", profile: "default", title: "Bank of Now — statements",
  url: "https://bank.example/statement", active: true,
};
const OTHER: TabRow = {
  id: "t9-other", profile: "orbit-two", title: "acme deployment secrets",
  url: "https://git.example/acme/orbit/secrets", active: false,
};
const ROWS: TabRow[] = [MINE, PERSON, OTHER];

let sent: string[] = [];
let sentArgs: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetBrowserDrive();
  sent = [];
  sentArgs = [];
  setBrowserSink({
    send: (ask) => {
      sent.push(ask.op);
      sentArgs.push(ask.args);
      const { id, op } = ask;
      const value = op === "open" || op === "newtab" ? openedReply({ id: MINE.id }, ROWS).value
        : op === "tab" ? selectedReply(ROWS, MINE).value
          : op === "closetab" ? closedReply(ROWS).value
            : op === "tabs" ? tabsReply(ROWS).value
              : op === "health" ? {
                summary: `window open, panel mounted, page alive (readyState=complete, url=${PERSON.url})`,
                mounted: true,
                hasPage: true,
              }
                : op === "observe" ? { url: MINE.url, title: MINE.title, console: [], network: [] }
                  : { tab: MINE.id, profile: agentContainerName(OWN) };
      queueMicrotask(() => settleBrowser(id, { ok: true, value }));
      return true;
    },
    listeners: () => 1,
    live: () => true,
  });
  noteBrowserReady("win-door", true);
});

afterEach(() => { __setBrowserAsker(null); resetBrowserDrive(); });

const names = (v: unknown) => JSON.stringify(v);

describe("every container's reply names only the worker's own pages", () => {
  test("do tabs", async () => {
    noteWorkerPage(OWN, MINE.id);
    const r = await runSteps([{ op: "tabs", args: {} }], { caller: { as: OWN }, worker: OWN });
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ op: "tabs", ok: true, value: [MINE] });
    expect(names(r)).not.toContain("bank.example");
    expect(names(r)).not.toContain("git.example");
  });

  test("do whoami", async () => {
    noteWorkerPage(OWN, MINE.id);
    const r = await runSteps([{ op: "whoami", args: {} }], { caller: { as: OWN }, worker: OWN });
    expect(r.ok).toBe(true);
    const value = r.steps[0].value as { activeTab: unknown; you: unknown };
    /* The person's front tab was not the worker's, so nothing in the answer
       names it, and the block that would have is emptied. */
    expect(value.activeTab).toBeNull();
    expect(value.you).toBeDefined();
    expect(names(r)).not.toContain("bank.example");
  });

  test("lanes with tabs", async () => {
    noteWorkerPage(OWN, MINE.id);
    const r = await runLanes(
      [{ page: MINE.id, steps: [{ op: "tabs", args: {} }] }],
      { caller: { as: OWN }, worker: OWN },
    );
    expect(r.lanes[0].steps).toEqual([{ op: "tabs", ok: true, value: [MINE] }]);
    expect(names(r)).not.toContain("bank.example");
    expect(names(r)).not.toContain("git.example");
  });

  test("a mixed sequence: an allowed open, then tabs", async () => {
    const r = await runSteps(
      [
        { op: "open", args: { profile: OWN, url: "https://orbit.example/" } },
        { op: "tabs", args: {} },
      ],
      { caller: { as: OWN }, worker: OWN },
    );
    expect(r.ok).toBe(true);
    expect(r.steps[1]).toMatchObject({ value: [MINE] });
    expect(names(r)).not.toContain("bank.example");
  });

  test("the list folded inside an open is filtered too", async () => {
    const r = await runSteps(
      [{ op: "open", args: { profile: OWN, url: "https://orbit.example/" } }],
      { caller: { as: OWN }, worker: OWN },
    );
    const value = r.steps[0].value as { id: string; tabs: TabRow[] };
    expect(value.id).toBe(MINE.id);
    expect(value.tabs).toEqual([MINE]);
    expect(names(r)).not.toContain("bank.example");
  });
});

describe("the credential's own lanes, not every caller's", () => {
  test("lane list names only what this worker opened", async () => {
    configureLanes({ manage: async () => ({ ok: true }), hosted: () => true, forget: () => undefined });
    const mine = await openLane(OWN, "private");
    const theirs = await openLane("orbit-two", "private");
    expect(mine.ok && theirs.ok).toBe(true);
    const parsed = parseAsk("lane", { action: "list" });
    if ("error" in parsed) throw new Error(parsed.error);
    noteWorkerAsk(parsed.ask.id, OWN, "lane");
    const r = await askBrowser(parsed.ask);
    const ids = (r.value as { lanes: Array<{ id: string }> }).lanes.map((l) => l.id);
    expect(ids).toEqual([mine.ok ? mine.lane.id : ""]);
    expect(names(r)).not.toContain(theirs.ok ? theirs.lane.id : "x");
  });
});

describe("the door is where a mint is addressed, and health is scoped", () => {
  const asked = (op: string, args: Record<string, unknown>) => {
    const parsed = parseAsk(op, args);
    if ("error" in parsed) throw new Error(parsed.error);
    noteWorkerAsk(parsed.ask.id, OWN, op);
    return parsed.ask;
  };

  test("a worker's mint reaches the panel under its own container, never empty", async () => {
    /* The panel reads an absent or empty profile as the person's container.
       The gate refuses both; this is the second layer on the one path every
       ask takes, so no composition can forward either. */
    for (const [op, args] of [
      ["newtab", { as: OWN, url: "https://orbit.example/", profile: "" }],
      ["open", { as: OWN, url: "https://orbit.example/", profile: "" }],
    ] as Array<[string, Record<string, unknown>]>) {
      sentArgs = [];
      await askBrowser(asked(op, args));
      expect({ op, profile: sentArgs[0]?.profile }).toEqual({ op, profile: agentContainerName(OWN) });
    }
  });

  test("a worker's health reports the layers and never the page", async () => {
    /* The panel's own answer is the one that leaked: its summary is built with
       `url=<getURL()>` of the mounted guest, which is the person's active tab.
       Driven here as the panel sends it. */
    __setBrowserAsker(async () => ({
      ok: true,
      value: {
        summary: `window open, panel mounted, page alive (readyState=complete, url=${PERSON.url})`,
        mounted: true,
        hasPage: true,
      },
    }));
    const r = await askBrowser(asked("health", { as: OWN }));
    expect(r.ok).toBe(true);
    expect(names(r)).not.toContain("bank.example");
    expect(names(r)).not.toContain(PERSON.title);
    for (const field of ["url", "title", "tab", "activeTab"]) expect(names(r)).not.toContain(`"${field}"`);
    expect(r.value).toMatchObject({ mounted: true, hasPage: true });
  });

  test("a mint the panel reports in another container is not filed as this worker's", async () => {
    /* The registry's own door: the panel's answer is the only report of which
       container a tab was born in, and a mint whose reply names somebody
       else's tab must not make that tab addressable. */
    setBrowserSink({
      send: (ask) => {
        queueMicrotask(() => settleBrowser(ask.id, { ok: true, value: { id: PERSON.id, tabs: ROWS } }));
        return true;
      },
      listeners: () => 1,
      live: () => true,
    });
    const parsed = parseAsk("newtab", { as: OWN, profile: OWN, url: "https://orbit.example/" });
    if ("error" in parsed) throw new Error(parsed.error);
    noteWorkerAsk(parsed.ask.id, OWN, "newtab");
    const r = await askBrowser(parsed.ask);
    expect(r.ok).toBe(true);
    expect(workerOwnsPage(OWN, PERSON.id)).toBe(false);
    expect(workerOwnsPage(OWN, MINE.id)).toBe(true);
  });

  test("an ask no window answered is forgotten, not left in the map", async () => {
    /* `askWithRetry` answers "the browser view is not open" before parking,
       so the settle path that deletes the entry never runs. Repeated, it grew
       the map one entry per ask. */
    setBrowserSink(null);
    const parsed = parseAsk("tabs", { as: OWN });
    if ("error" in parsed) throw new Error(parsed.error);
    noteWorkerAsk(parsed.ask.id, OWN, "tabs");
    const r = await askBrowser(parsed.ask);
    expect(r.ok).toBe(false);
    expect(workerAskCount()).toBe(0);
  });
});

/* The guard that would have caught the leak the routes had: a panel reply
   scoped anywhere but the door is how one container gets forgotten. */
describe("the door is the only place a reply is scoped", () => {
  const source = async (rel: string) =>
    Bun.file(new URL(rel, import.meta.url)).text();

  test("no route scopes a reply itself", async () => {
    const router = await source("../src/index.ts");
    expect(router).not.toContain("workerReply(");
    /* And every route that returns a panel answer returns the one the door
       handed it. */
    const lines = router.split("\n");
    const sites = lines.flatMap((l, i) => (l.includes("await askBrowser(") ? [i] : []));
    expect(sites.length).toBeGreaterThan(0);
    for (const i of sites) {
      expect(lines[i]).toContain("const reply = await askBrowser(");
      const tail = lines.slice(i, i + 24).join("\n");
      expect(tail).toMatch(/return json\((reply|answered)\b/);
      expect(tail).not.toContain("workerReply(");
    }
  });

  test("browserdrive scopes exactly once, inside the door", async () => {
    const drive = await source("../src/browserdrive.ts");
    /* The declaration, and one call: the door's. */
    expect(drive.split("workerReply(").length - 1).toBe(2);
    const start = drive.indexOf("export async function askBrowser(");
    const end = drive.indexOf("async function askPanel(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(drive.slice(start, end)).toContain("workerReply(");
  });
});
