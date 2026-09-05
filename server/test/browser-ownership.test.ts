/*
 * WHO OWNS THE PANE, AND WHO IS ALLOWED TO THROW A CONTAINER AWAY.
 *
 * The incident these lock down, in the owner's words: "another agent was
 * getting into that container and putting its data on that screen… the other
 * agent was going in to take screenshots and couldn't, because the first one
 * was overwriting on top of it." One agent's proof-of-life run was overwritten by
 * another that believed it was isolated, and neither side had any way to see
 * it: `profiles` answered a flat list of bare names, so "this container is
 * mine" and "this container is somebody else's and they are in it right now"
 * were the same answer.
 *
 * Two things are pinned here, and each one is a different half of that:
 *
 *   §11 — the pre-flight. One call that touches no page and says who this
 *         identity is, whether it still holds a live tab, and which container
 *         owns the tab that is actually on screen.
 *   §13 — the ownership ledger behind it, and the refusal it makes possible:
 *         `profiles --drop` on a container somebody else created closes every
 *         tab in it and clears its login, and it used to do that silently.
 *
 * These are relay-level, in-process. The CLI's half — the stderr notices, the
 * shape it prints — is in browser-cli-ownership.test.ts, end to end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askBrowser, BROWSER_OPS, containerRecord, exportAudit, noteBrowserReady,
  parseAsk, resetAudit, resetBrowserDrive, resetContainerLedger, setBrowserSink,
} from "../src/browserdrive.ts";

/* The ledger is a FILE, and its path is resolved on every call precisely so a
   test can put it somewhere that is not the operator's ~/.config. A previous
   incident in this repository — a probe that rewrote a real tmux config —
   is why this is a scratch directory and not a hope. */
let scratch = "";
let previous: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "agx-owner-"));
  previous = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = scratch;
});

afterAll(() => {
  if (previous === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = previous;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* fine */ }
});

afterEach(() => {
  resetBrowserDrive();
  resetAudit();
  resetContainerLedger();
});

/**
 * A stand-in window, answering each op from a table.
 *
 * `whoami` is deliberately absent from the table and always will be: the window
 * has never met the caller, so there is nothing for it to answer. If the relay
 * ever forwards it, the table says "the stand-in was not told what to say" and
 * the test that expects a composed answer fails loudly instead of quietly
 * inventing one.
 */
function window(table: Record<string, { ok: boolean; value?: unknown; error?: string }>) {
  const seen: string[] = [];
  setBrowserSink({
    send: (ask) => {
      seen.push(ask.op);
      const r = table[ask.op] ?? { ok: false, error: `the stand-in was not told what to say about ${ask.op}` };
      queueMicrotask(() => {
        void import("../src/browserdrive.ts").then((m) => m.settleBrowser(ask.id, r));
      });
    },
    listeners: () => 1,
  });
  noteBrowserReady("w-owner", true);
  return seen;
}

/** Two containers alive, one of them holding the tab that is on screen. */
const TWO_CONTAINERS = {
  tabs: {
    ok: true,
    value: [
      { id: "t1", title: "Orbit board", url: "https://orbit.example/b", active: false, profile: "orbit-a1b2c3" },
      { id: "t2", title: "Orbit ticket", url: "https://orbit.example/t", active: true, profile: "peer-9f9f9f" },
      { id: "t3", title: "Docs", url: "https://docs.example/", active: false, profile: "peer-9f9f9f" },
    ],
  },
  profiles: { ok: true, value: { profiles: ["orbit-a1b2c3", "peer-9f9f9f"] } },
};

describe("§11 — the pre-flight", () => {
  test("`whoami` is a verb, and it is never sent to the window", async () => {
    expect(BROWSER_OPS).toContain("whoami");
    const seen = window(TWO_CONTAINERS);
    const r = await askBrowser({ id: "a1", op: "whoami", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    expect(r.ok).toBe(true);
    /* The window was asked for the tab LIST — the only half of this question
       it can answer — and never for a verb it has no case for. */
    expect(seen).toEqual(["tabs"]);
  });

  test("`whoami` reports a live tab as live, and a stale one as gone", async () => {
    window(TWO_CONTAINERS);
    const live = await askBrowser({ id: "a2", op: "whoami", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    expect((live.value as any).you).toEqual({ identity: "orbit-a1b2c3", tab: "t1", tabLive: true });

    /* THE CASE REQ-2's REFUSAL POINTS AT. A remembered tab that no longer
       exists is exactly how an agent that passed `--as` on every call ends up
       driving somebody else's page: the request names no page, and a request
       that names no page is not "unspecified" to the relay, it is "the tab in
       front". `tabLive: false` is that state, said out loud, before it costs
       anything. */
    const stale = await askBrowser({ id: "a3", op: "whoami", args: { identity: "orbit-a1b2c3", tab: "t99" } });
    expect((stale.value as any).you.tabLive).toBe(false);

    /* And an identity that never had one at all. */
    const none = await askBrowser({ id: "a4", op: "whoami", args: { identity: "orbit-a1b2c3" } });
    expect((none.value as any).you).toEqual({ identity: "orbit-a1b2c3", tab: null, tabLive: false });
  });

  test("`whoami` names the container that owns the visible pane, not the caller's", async () => {
    window(TWO_CONTAINERS);
    const r = await askBrowser({ id: "a5", op: "whoami", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    const active = (r.value as any).activeTab;
    /* t2 is the active row and it belongs to the OTHER container. An agent
       about to take a screenshot needs to read this before it fires. */
    expect(active.id).toBe("t2");
    expect(active.profile).toBe("peer-9f9f9f");
    expect(active.title).toBe("Orbit ticket");
  });

  test("with two containers alive, exactly one owns the active tab", async () => {
    window(TWO_CONTAINERS);
    const r = await askBrowser({ id: "a6", op: "profiles", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    const v = r.value as any;
    const owning = v.profiles.filter((p: any) => p.ownsActive);
    expect(owning).toHaveLength(1);
    expect(owning[0].name).toBe("peer-9f9f9f");
    /* And the two halves of the answer agree with each other. A shape where
       `activeTab.profile` and `ownsActive` can disagree is worse than no
       answer, because it reads as authoritative. */
    expect(v.activeTab.profile).toBe(owning[0].name);
  });

  test("`profiles` counts the tabs each container holds, and keeps `names` verbatim", async () => {
    window(TWO_CONTAINERS);
    const r = await askBrowser({ id: "a7", op: "profiles", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    const v = r.value as any;
    /* The old shape, under a new key. Every existing reader — the MCP tool,
       a shell script somebody wrote once — moves from `value.profiles[0]` to
       `value.names[0]` and nothing else changes. */
    expect(v.names).toEqual(["orbit-a1b2c3", "peer-9f9f9f"]);
    expect(v.profiles.find((p: any) => p.name === "orbit-a1b2c3").tabs).toBe(1);
    expect(v.profiles.find((p: any) => p.name === "peer-9f9f9f").tabs).toBe(2);
  });

  test("neither verb accepts `--page`: they are about the list, not a page", () => {
    for (const op of ["whoami", "profiles"] as const) {
      const r = parseAsk(op, { page: "t2", identity: "orbit-a1b2c3" });
      expect("ask" in r).toBe(true);
      /* Not an error — a stray global flag should not fail a question — but
         the page is DROPPED rather than carried, because carrying it is how a
         list question gets answered about one tab. */
      expect((r as any).ask.args.page).toBeUndefined();
    }
  });

  test("both appear in the audit, with no page, having changed nothing", async () => {
    window(TWO_CONTAINERS);
    resetAudit();
    await askBrowser({ id: "a8", op: "whoami", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    await askBrowser({ id: "a9", op: "profiles", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    const ops = exportAudit().map((e) => e.op);
    expect(ops).toContain("whoami");
    expect(ops).toContain("profiles");
    /* The inner `tabs` asks are in there too, on purpose: the audit is
       evidence, and hiding what actually crossed the wire would make it lie. */
    expect(ops).toContain("tabs");
    for (const e of exportAudit()) expect((e.args as any).page).toBeUndefined();
  });

  test("an identity that is a payload rather than a name is refused", () => {
    expect("error" in parseAsk("whoami", { identity: "a\nb" })).toBe(true);
    expect("error" in parseAsk("whoami", { identity: "x".repeat(65) })).toBe(true);
    expect("ask" in parseAsk("whoami", { identity: "orbit-a1b2c3" })).toBe(true);
    /* And no identity at all is a fair question — "who owns the screen" is
       worth asking from a shell that has not picked a name yet. */
    expect("ask" in parseAsk("whoami", {})).toBe(true);
  });
});

describe("§13 — who created this container", () => {
  test("the first caller to name a container is its creator; later ones only move the clock", () => {
    parseAsk("open", { url: "https://orbit.example/", profile: "shared-name", identity: "orbit-a1b2c3" });
    const first = containerRecord("shared-name");
    expect(first).not.toBeNull();
    expect(first!.creator).toBe("orbit-a1b2c3");

    /* The second session picks the same name. This is the collision: the panel
       resolves a container by NAME against a machine-wide list and only mints
       when the name is absent, so this `open` JOINS rather than makes. What
       must not happen is the ledger changing hands under it. */
    parseAsk("open", { url: "https://orbit.example/", profile: "shared-name", identity: "peer-9f9f9f" });
    expect(containerRecord("shared-name")!.creator).toBe("orbit-a1b2c3");
    expect(containerRecord("shared-name")!.lastSeenMs).toBeGreaterThanOrEqual(first!.lastSeenMs);
  });

  test("dropping somebody else's container is refused, and the refusal names them", () => {
    parseAsk("profiles", { make: "peer-work", identity: "peer-9f9f9f" });
    const r = parseAsk("profiles", { drop: "peer-work", identity: "orbit-a1b2c3" });
    expect("error" in r).toBe(true);
    const msg = (r as { error: string }).error;
    expect(msg).toContain("peer-9f9f9f");
    expect(msg).toContain("--force");
    /* Refused above the wire, so it costs no round trip — and the refusal is
       in the audit next to the allow-list ones, which are the other two things
       this relay says no to. */
    expect(exportAudit().some((e) => e.op === "profiles" && !e.ok)).toBe(true);
    /* AND THE CONTAINER IS STILL CLAIMED. A refusal that quietly forgot who
       owned it would hand the next caller a free hand. */
    expect(containerRecord("peer-work")!.creator).toBe("peer-9f9f9f");
  });

  test("dropping your own succeeds, and `--force` gets you through a foreign one", () => {
    parseAsk("profiles", { make: "mine-work", identity: "orbit-a1b2c3" });
    expect("ask" in parseAsk("profiles", { drop: "mine-work", identity: "orbit-a1b2c3" })).toBe(true);

    parseAsk("profiles", { make: "peer-work", identity: "peer-9f9f9f" });
    expect("ask" in parseAsk("profiles", { drop: "peer-work", identity: "orbit-a1b2c3", force: true })).toBe(true);
  });

  test("a container nobody claimed is allowed through — and says so rather than staying quiet", async () => {
    /* Every container that predates this ledger is in this state, and refusing
       them would strand the ones already on disk. So: allowed, with the
       warning that goes with it, because silence here reads as "it was mine". */
    const parsed = parseAsk("profiles", { drop: "from-before", identity: "orbit-a1b2c3" });
    expect("ask" in parsed).toBe(true);

    window({ profiles: { ok: true, value: { dropped: "from-before" } } });
    const r = await askBrowser((parsed as any).ask);
    expect(r.ok).toBe(true);
    expect((r.value as any).creator).toBeNull();
    expect(String((r.value as any).warning)).toContain("from-before");
  });

  test("a drop the window REFUSES leaves the ledger claim intact", async () => {
    parseAsk("profiles", { make: "still-here", identity: "orbit-a1b2c3" });
    const parsed = parseAsk("profiles", { drop: "still-here", identity: "orbit-a1b2c3" });
    window({ profiles: { ok: false, error: "no container called still-here" } });
    const r = await askBrowser((parsed as any).ask);
    expect(r.ok).toBe(false);
    /*
     * The first version of this cleared the ledger at PARSE time, which reads
     * fine and is wrong: a drop the window refuses would have already erased
     * the owner, so a second, correct attempt would find the container
     * unclaimed and destroy it. The claim survives a failed drop.
     */
    expect(containerRecord("still-here")!.creator).toBe("orbit-a1b2c3");
  });

  test("a drop that WORKS releases the name, so the next agent to mint it owns it", async () => {
    parseAsk("profiles", { make: "recycled", identity: "peer-9f9f9f" });
    const parsed = parseAsk("profiles", { drop: "recycled", identity: "peer-9f9f9f" });
    window({ profiles: { ok: true, value: { dropped: "recycled" } } });
    await askBrowser((parsed as any).ask);
    expect(containerRecord("recycled")).toBeNull();

    parseAsk("profiles", { make: "recycled", identity: "orbit-a1b2c3" });
    expect(containerRecord("recycled")!.creator).toBe("orbit-a1b2c3");
  });

  test("`profiles` marks yours as yours and a peer's as a peer's", async () => {
    parseAsk("open", { url: "https://orbit.example/", profile: "orbit-a1b2c3", identity: "orbit-a1b2c3" });
    parseAsk("open", { url: "https://orbit.example/", profile: "peer-9f9f9f", identity: "peer-9f9f9f" });
    window(TWO_CONTAINERS);
    const r = await askBrowser({ id: "b1", op: "profiles", args: { identity: "orbit-a1b2c3", tab: "t1" } });
    const rows = (r.value as any).profiles as any[];
    expect(rows.find((p) => p.name === "orbit-a1b2c3").mine).toBe(true);
    expect(rows.find((p) => p.name === "peer-9f9f9f").mine).toBe(false);
    expect(rows.find((p) => p.name === "peer-9f9f9f").creator).toBe("peer-9f9f9f");
    expect(rows.find((p) => p.name === "peer-9f9f9f").lastActivityMs).toBeGreaterThan(0);
  });
});
