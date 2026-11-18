/*
 * Login vault security fixes, run 7 (review findings 1, 3 and 4, server side).
 * The window is a fake: it answers counts, never a value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  askBrowser, forgetVaultLane, forgetWorkerPages, isVaultLane, markVaultLane, noteBrowserManager, noteBrowserReady,
  resetBrowserDrive, setBrowserSink, settleBrowser, vaultLaneRefusal, type BrowserAsk,
} from "../src/browserdrive.ts";
import { configureLanes, laneKnown, openLane } from "../src/lanes.ts";
import { vaultLaneDoor } from "../src/vaultAsk.ts";
import { endWindow } from "../src/agentops.ts";

const AGENT = "orbit-1";
let seenDuringPull: { guarded: boolean; cookies: string | null }[] = [];
let pullAnswer: Record<string, unknown> | null = null;
let dropped: string[] = [];
/* What Electron main reports on its own key (POST /vault/lane) before the
   first cookie: the vault's "sign agents out" setting. */
let mainSignOut: boolean | undefined = true;
/* When set, the window holds a pull's answer (the person's dialog is open). */
let holdPull: ((answer: unknown) => void) | null | undefined;

beforeEach(() => {
  resetBrowserDrive();
  seenDuringPull = [];
  dropped = [];
  mainSignOut = true;
  holdPull = undefined;
  pullAnswer = { ok: true, site: "acme.test", vault: "zen:abc/0", set: 2, failed: 0, sensitive: false, signOutAtEnd: true };
  setBrowserSink({
    send: (ask: BrowserAsk) => {
      const pull = (ask.args as { vaultPull?: { lane: string } }).vaultPull;
      if (pull && holdPull === null) {
        holdPull = (answer) => settleBrowser(ask.id, { ok: true, value: answer });
        return true;
      }
      if (pull) {
        /* Main reports the lane only once it is going to fill it. */
        if (pullAnswer?.ok === true) markVaultLane(pull.lane, mainSignOut);
        /* What an agent's read would meet while main is setting the cookies. */
        seenDuringPull.push({ guarded: isVaultLane(pull.lane), cookies: vaultLaneRefusal("cookies", pull.lane) });
        const answer = pullAnswer;
        if (answer) queueMicrotask(() => settleBrowser(ask.id, { ok: true, value: answer }));
        else queueMicrotask(() => settleBrowser(ask.id, { ok: false, error: "timed out" }));
        return true;
      }
      queueMicrotask(() => settleBrowser(ask.id, { ok: true, value: {} }));
      return true;
    },
    listeners: () => 1,
    live: () => true,
  });
  noteBrowserReady("win-vault", true);
  noteBrowserManager("win-vault", true);
  configureLanes({
    manage: async (a) => { if ("drop" in a) dropped.push(a.drop); return { ok: true }; },
    hosted: () => true,
    forget: () => undefined,
  });
});

afterEach(() => resetBrowserDrive());

async function lane(): Promise<string> {
  const r = await openLane(AGENT, "ephemeral");
  if (!r.ok) throw new Error(r.error);
  return r.lane.id;
}
const pull = (id: string) => askBrowser({ id: `v-${id}`, op: "lane", args: { action: "vault", id, site: "acme.test", as: AGENT } });

describe("finding 1: the lane is guarded before the first cookie", () => {
  it("refuses cookies in the lane while the pull is still running", async () => {
    const id = await lane();
    const r = await pull(id);
    expect(r.ok).toBe(true);
    expect(seenDuringPull).toHaveLength(1);
    expect(seenDuringPull[0]!.guarded).toBe(true);
    expect(seenDuringPull[0]!.cookies).toContain("login vault");
    expect(isVaultLane(id)).toBe(true);
  });

  it("a pull main refuses leaves the lane open and unmarked (nothing was set)", async () => {
    const id = await lane();
    pullAnswer = { ok: false, code: "ambiguous", error: "two vaults", vaults: ["a", "b"] };
    const r = await pull(id);
    expect(r.ok).toBe(false);
    expect(isVaultLane(id)).toBe(false);
    expect(laneKnown(id)).toBe(true);
  });

  it("a pull with no answer closes the lane: main may have set some cookies", async () => {
    const id = await lane();
    pullAnswer = null;
    const r = await pull(id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("the lane was closed");
    expect(laneKnown(id)).toBe(false);
    expect(dropped).toContain(id);
  });
});

describe("finding 3: main reports every lane it fills, on its own key", () => {
  it("takes main's key only", () => {
    expect(vaultLaneDoor({ main: "", agent: false }, { lane: "lane_1" }, "k-main").status).toBe(403);
    expect(vaultLaneDoor({ main: "k-desk", agent: false }, { lane: "lane_1" }, "k-main").status).toBe(403);
    expect(vaultLaneDoor({ main: "k-main", agent: true }, { lane: "lane_1" }, "k-main").status).toBe(403);
    expect(vaultLaneDoor({ main: "k-main", agent: false }, { lane: "lane_1" }, "").status).toBe(403);
    expect(vaultLaneDoor({ main: "k-main", agent: false }, { lane: "../x" }, "k-main").status).toBe(400);
    expect(vaultLaneDoor({ main: "k-main", agent: false }, { lane: "lane_1", signOutAtEnd: true }, "k-main").body)
      .toEqual({ ok: true, lane: "lane_1", signOutAtEnd: true });
  });

  it("a lane main marked refuses read-back verbs, with no agent pull at all", () => {
    expect(vaultLaneRefusal("cookies", "lane_w")).toBeNull();
    markVaultLane("lane_w", true);
    expect(vaultLaneRefusal("cookies", "lane_w")).toContain("login vault");
    expect(vaultLaneRefusal("eval", "lane_w")).toContain("login vault");
    forgetVaultLane("lane_w");
  });
});

describe("finding 4: done signs the agent out of its vault lanes", () => {
  it("closes the agent's vault lanes when the setting is on", async () => {
    const id = await lane();
    expect((await pull(id)).ok).toBe(true);
    const plain = await lane();
    await askBrowser({ id: "d-1", op: "done", args: { as: AGENT } });
    expect(laneKnown(id)).toBe(false);
    expect(dropped).toContain(id);
    expect(laneKnown(plain)).toBe(true);
    expect(isVaultLane(id)).toBe(false);
  });

  it("keeps the lane when the person turned the setting off", async () => {
    const id = await lane();
    mainSignOut = false;
    pullAnswer = { ...pullAnswer!, signOutAtEnd: false };
    expect((await pull(id)).ok).toBe(true);
    await askBrowser({ id: "d-2", op: "done", args: { as: AGENT } });
    expect(laneKnown(id)).toBe(true);
  });

  it("another agent's done does not close my lane", async () => {
    const id = await lane();
    expect((await pull(id)).ok).toBe(true);
    await askBrowser({ id: "d-3", op: "done", args: { as: "orbit-2" } });
    expect(laneKnown(id)).toBe(true);
  });
});

describe("run 8: sign-out has one source and covers every end", () => {
  it("finding 4: an agent whose turn ends without done is signed out too", async () => {
    const id = await lane();
    expect((await pull(id)).ok).toBe(true);
    forgetWorkerPages(AGENT);
    for (let i = 0; i < 50 && (laneKnown(id) || isVaultLane(id)); i++) await new Promise((r) => setTimeout(r, 2));
    expect(laneKnown(id)).toBe(false);
    expect(dropped).toContain(id);
    expect(isVaultLane(id)).toBe(false);
  });

  it("new 1: the window's answer cannot turn sign-out off; main's report decides", async () => {
    const id = await lane();
    pullAnswer = { ...pullAnswer!, signOutAtEnd: false };
    expect((await pull(id)).ok).toBe(true);
    await askBrowser({ id: "d-4", op: "done", args: { as: AGENT } });
    expect(laneKnown(id)).toBe(false);
  });
});

describe("sec 4: every end of a worker's window signs it out", () => {
  const gone = async (id: string) => {
    for (let i = 0; i < 50 && (laneKnown(id) || isVaultLane(id)); i++) await new Promise((r) => setTimeout(r, 2));
  };

  it("finding 4: a worker whose window ends on its own (no done, no stop) is signed out", async () => {
    const id = await lane();
    expect((await pull(id)).ok).toBe(true);
    endWindow(AGENT);
    await gone(id);
    expect(laneKnown(id)).toBe(false);
    expect(dropped).toContain(id);
    expect(isVaultLane(id)).toBe(false);
  });

  it("finding 4: a lane whose pull is still waiting on the person closes when the worker's window ends", async () => {
    const id = await lane();
    holdPull = null;
    const asked = pull(id);
    for (let i = 0; i < 50 && !holdPull; i++) await new Promise((r) => setTimeout(r, 2));
    expect(holdPull).toBeTruthy();
    endWindow(AGENT);
    await gone(id);
    expect(laneKnown(id)).toBe(false);
    expect(dropped).toContain(id);
    holdPull!({ ok: false, code: "refused", error: "lane closed" });
    await asked;
  });
});
