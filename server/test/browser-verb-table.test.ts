/*
 * THE WORKER'S VERB TABLE IS THE ONE DECISION, AND A NEW VERB CANNOT SKIP IT.
 *
 * Rounds 6-9 each found one more verb missing a guard (`closetab`, then
 * `tabs`). The table in browserdrive.ts now has a row for every verb the CLI
 * parser and the panel's op switch expose, and this file fails when one of them
 * has no row. The second test runs every page- or id-addressed row through the
 * same gate the route calls, with four ids.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BROWSER_OPS, WORKER_OPS, WORKER_VERBS, agentAskRefusal, noteWorkerPage,
  resetWorkerPages, workerReply,
} from "../src/browserdrive.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const PANEL = new URL("../../web/src/lib/browserDrive.ts", import.meta.url).pathname;
const PANEL_BUS = new URL("../../web/src/lib/browserBus.ts", import.meta.url).pathname;

function cliVerbs(): string[] {
  const src = readFileSync(CLI, "utf8");
  const names = new Set([...src.matchAll(/\bsub\.add_parser\(\s*"([^"]+)"/g)].map((m) => m[1]));
  /* `dblclick`, `rightclick`, `hover`, `focus`, `blur` and `check` are made in
     a loop over a tuple rather than one add_parser call each. */
  const loop = /for verb, what in \((.*?)\):/s.exec(src);
  if (loop) for (const m of loop[1].matchAll(/\("([a-z0-9-]+)", "/g)) names.add(m[1]);
  return [...names].sort();
}

const panelOps = () =>
  [...readFileSync(PANEL, "utf8").matchAll(/case "([^"]+)"/g)].map((m) => m[1]).sort();

/** The tab verbs are a SECOND switch, in browserBus.ts: tab, tabs, profiles,
 *  newtab, open, closetab. A verb added there and nowhere else used to leave
 *  this file green, which is how `closetab` went a round without a row. */
function panelTabOps(): string[] {
  const src = readFileSync(PANEL_BUS, "utf8");
  const start = src.indexOf("async function serveTabs(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/case "([^"]+)"/g)].map((m) => m[1]).sort();
}

/** The verbs the CLI tells a worker it cannot run, mirroring the table's
 *  refused rows. A drift either way is a sentence that lies. */
function cliRefusedVerbs(): string[] {
  const src = readFileSync(CLI, "utf8");
  const at = src.indexOf("RELAY_REFUSED_VERBS = frozenset({");
  expect(at).toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf("})", at));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

describe("every verb a surface exposes has a decided row", () => {
  test("the CLI parser's verbs are all in the table", () => {
    const verbs = cliVerbs();
    expect(verbs.length).toBeGreaterThan(80);
    expect(verbs.filter((v) => !(v in WORKER_VERBS))).toEqual([]);
  });

  test("the panel's ops are all in the table", () => {
    expect(panelOps().filter((op) => !(op in WORKER_VERBS))).toEqual([]);
  });

  test("the panel's tab switch is all in the table", () => {
    const ops = panelTabOps();
    expect(ops.length).toBeGreaterThan(3);
    expect(ops.filter((op) => !(op in WORKER_VERBS))).toEqual([]);
  });

  test("the panel's tab answers are built by the shared builders the tests use", () => {
    const src = readFileSync(PANEL_BUS, "utf8");
    const start = src.indexOf("async function serveTabs(");
    const body = src.slice(start, src.indexOf("\n}", start));
    for (const builder of ["tabsReply(", "selectedReply(", "closedReply(", "openedReply("]) {
      expect({ builder, used: body.includes(builder) }).toEqual({ builder, used: true });
    }
    expect(body).not.toContain("value: tabs.list()");
  });

  test("the CLI's refused-verb sentence matches the table's refused rows", () => {
    const refused = Object.entries(WORKER_VERBS).filter(([, r]) => r.policy === "refused").map(([op]) => op).sort();
    expect(cliRefusedVerbs()).toEqual(refused);
  });

  test("the server's own verb list is all in the table", () => {
    expect([...BROWSER_OPS].filter((op) => !(op in WORKER_VERBS))).toEqual([]);
  });

  test("an allowed row names what it addresses, and a refused one addresses nothing", () => {
    for (const [op, row] of Object.entries(WORKER_VERBS)) {
      if (row.policy === "own") expect({ op, target: row.target.length <= 1 }).toEqual({ op, target: true });
      else expect({ op, target: row.target, fields: row.fields }).toEqual({ op, target: [], fields: [] });
    }
  });
});

describe("the gate answers the same for every addressed verb", () => {
  const OWN = "orbit-1";
  const OWN_PAGE = "t9-own";
  beforeEach(() => {
    resetWorkerPages();
    noteWorkerPage(OWN, OWN_PAGE);
  });

  test("person's, another agent's and a nonexistent id are refused; the own one is allowed", () => {
    for (const [op, row] of Object.entries(WORKER_VERBS)) {
      if (row.policy !== "own" || row.target.length === 0) continue;
      const field = row.target[0];
      for (const [why, id, expected] of [
        ["the person's tab", "t1-personal", "refused"],
        ["another agent's tab", "t4-other", "refused"],
        ["a tab that does not exist", "t0-missing", "refused"],
        ["its own page", OWN_PAGE, "allowed"],
      ] as Array<[string, string, "refused" | "allowed"]>) {
        const refused = agentAskRefusal({ as: OWN, [field]: id }, OWN, op);
        expect({ op, why, got: refused ? "refused" : "allowed" }).toEqual({ op, why, got: expected });
      }
    }
  });
});

describe("a tabs reply is the worker's own pages", () => {
  test("the window's list is filtered, and the active tab with it", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", "t9-own");
    const reply = workerReply("orbit-1", {
      ok: true,
      value: {
        tab: "t1-personal",
        tabs: [
          { id: "t1-personal", title: "Bank", url: "https://bank.example/", active: true },
          { id: "t9-own", profile: "orbit-1" },
          { id: "t4-other", title: "Other" },
        ],
      },
    });
    const value = reply.value as { tab: string; tabs: Array<{ id: string }> };
    expect(value.tabs.map((t) => t.id)).toEqual(["t9-own"]);
    /* Not substituted with the survivor: an id the worker did not open is
       never handed back in its place. */
    expect(value.tab).toBeNull();
  });

  test("whoami's active tab is dropped when it is not the worker's", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", "t9-own");
    const reply = workerReply("orbit-1", {
      ok: true,
      value: { you: { identity: "orbit-1", tab: "t9-own", tabLive: true }, activeTab: { id: "t1-personal" } },
    });
    const value = reply.value as { activeTab: unknown; you: { tabLive: boolean } };
    expect(value.activeTab).toBeNull();
    expect(value.you.tabLive).toBe(false);
  });

  test("whoami's tabLive is false for a tab the worker did not open", () => {
    resetWorkerPages();
    noteWorkerPage("orbit-1", "t9-own");
    const reply = workerReply("orbit-1", {
      ok: true,
      value: { you: { identity: "orbit-1", tab: "t1-personal", tabLive: true } },
    });
    const value = reply.value as { you: { tab: string | null; tabLive: boolean } };
    expect({ tab: value.you.tab, live: value.you.tabLive }).toEqual({ tab: null, live: false });
  });
});
