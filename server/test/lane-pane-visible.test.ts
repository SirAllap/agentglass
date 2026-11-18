/*
 * An agent's lane in the person's Browser pane: the relay tells the pane when
 * lanes change, names a vault lane by its box, and `--show` on a lane says
 * whether there was a pane to bring it forward. Fakes only: the sink stands in
 * for the window that makes hosts, the host and the person's panel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAskRefusal, askBrowser, noteBrowserManager, noteBrowserReady, noteWorkerAsk, paneLaneRows, parseAsk, resetBrowserDrive,
  setBrowserSink, settleBrowser, vaultDisplayName, type BrowserAsk,
} from "../src/browserdrive.ts";
import { LANE_BUSY_MS, onLanesChanged, touchLane } from "../src/lanes.ts";

let heard: string[] = [];
let sentShow: unknown[] = [];
let dir = "";
const prevDir = process.env.AGX_VAULT_DIR;

beforeEach(() => {
  resetBrowserDrive();
  heard = [];
  sentShow = [];
  onLanesChanged((show) => heard.push(show ?? "-"));
  dir = mkdtempSync(join(tmpdir(), "agx-lane-pane-"));
  process.env.AGX_VAULT_DIR = dir;
  writeFileSync(join(dir, "index.json"), JSON.stringify({ v: 1, vaults: { "zen:abc/0": { label: "Zen — Orbit", file: "x.vault", sites: 1 } } }));
  setBrowserSink({
    send: (a) => {
      if (a.op === "open") sentShow.push(a.args.show);
      queueMicrotask(() => {
        settleBrowser(a.id, { ok: true, value: a.op === "lane" ? "done" : { id: `lane-${String(a.args.lane)}` } });
        const make = a.args.make;
        if (a.op === "lane" && typeof make === "string") noteBrowserReady(`host-${make}`, true, [make]);
      });
    },
    listeners: () => 1,
    live: () => true,
  });
  noteBrowserManager("mgr", true);
});
afterEach(() => {
  onLanesChanged(null);
  resetBrowserDrive();
  rmSync(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
});

const run = (op: string, body: Record<string, unknown>) => {
  const p = parseAsk(op, { as: "orbit", ...body });
  if ("error" in p) throw new Error(p.error);
  return askBrowser(p.ask as BrowserAsk);
};
const lane = async (body: Record<string, unknown> = {}) => {
  const r = await run("lane", { action: "new", ...body });
  expect(r.ok, r.error).toBe(true);
  return (r.value as { lane: { id: string } }).lane.id;
};

describe("the pane hears about lanes", () => {
  test("a lane opening and closing each tells the pane once", async () => {
    const id = await lane();
    expect(heard).toEqual(["-"]);
    await run("lane", { action: "close", id });
    expect(heard).toEqual(["-", "-"]);
  });

  test("a lane starting to work tells the pane; another ask while it works does not", async () => {
    const id = await lane();
    heard = [];
    touchLane(id);
    expect(heard).toEqual([]);
    const real = Date.now;
    try {
      Date.now = () => real() + LANE_BUSY_MS + 1;
      touchLane(id);
      expect(heard).toEqual(["-"]);
      touchLane(id);
      expect(heard).toEqual(["-"]);
    } finally { Date.now = real; }
  });
});

describe("a vault lane is named by its box", () => {
  test("the row carries the name Settings shows, and the id beside it", async () => {
    await lane({ ephemeral: true, vault: "zen:abc/0" });
    const [row] = paneLaneRows();
    expect(row).toMatchObject({ container: "ephemeral", as: "orbit", vault: "Zen — Orbit", vaultId: "zen:abc/0" });
  });

  test("a name typed the loose way resolves to the same box", () => {
    expect(vaultDisplayName("zen - orbit")).toBe("Zen — Orbit");
    expect(vaultDisplayName("zen:abc/0")).toBe("Zen — Orbit");
    expect(vaultDisplayName("nobody")).toBe("nobody");
  });
});

describe("open --lane --show", () => {
  test("with the person's pane open: marked in the overview, never shown over their page, and the pane is told which lane", async () => {
    const id = await lane();
    noteBrowserReady("win-person", true);
    heard = [];
    const r = await run("open", { url: "https://acme.test/", lane: id, show: true });
    expect(r.ok, r.error).toBe(true);
    const v = r.value as { shown: boolean; marked: boolean; why: string };
    /* The pane may be hidden, and the person opens the watch: "shown" would not be the truth. */
    expect(v.shown).toBe(false);
    expect(v.marked).toBe(true);
    expect(v.why).toContain("Browser overview");
    expect(heard).toEqual([id]);
  });

  test("with no pane open: not shown, one sentence why, and the pane is told nothing", async () => {
    const id = await lane();
    heard = [];
    const r = await run("open", { url: "https://acme.test/", lane: id, show: true });
    expect(r.ok, r.error).toBe(true);
    const v = r.value as { shown: boolean; why: string };
    expect(v.shown).toBe(false);
    expect(v.why).toContain("Browser pane is not open");
    expect(heard).toEqual([]);
  });

  test("from a worker: a no-op said in one sentence; the page opens, the pane is told nothing, show never reaches the window", async () => {
    const id = await lane();
    noteBrowserReady("win-person", true);
    heard = [];
    expect(agentAskRefusal({ url: "https://acme.test/", lane: id, show: true, as: "orbit" }, "orbit", "open")).toBeNull();
    const p = parseAsk("open", { as: "orbit", url: "https://acme.test/", lane: id, show: true });
    if ("error" in p) throw new Error(p.error);
    noteWorkerAsk(p.ask.id, "orbit", "open");
    const r = await askBrowser(p.ask as BrowserAsk);
    expect(r.ok, r.error).toBe(true);
    const v = r.value as { shown: boolean; why: string };
    expect(v.shown).toBe(false);
    expect(v.why).toContain("never takes the person's view");
    expect(heard).toEqual([]);
    expect(sentShow).toEqual([undefined]);
  });

  test("without --show the answer says nothing about showing", async () => {
    const id = await lane();
    noteBrowserReady("win-person", true);
    const r = await run("open", { url: "https://acme.test/", lane: id });
    expect((r.value as Record<string, unknown>).shown).toBeUndefined();
  });
});
