/*
 * An orchestrator that is relayed is a fresh session in a new window, and it
 * does not adopt again. The row kept pointing at the old pane, so the card
 * read "Stood down" over a live orchestrator and the Seat button would have
 * started a second one. A live window named like the seat re-links the row;
 * a deliberate stand-down is not undone by it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("relink"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const status = async () => (await (await fetch(`${h.base}/seat?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json()) as any;
const settled = async (f: () => Promise<boolean>) => { for (let i = 0; i < 40; i++) { if (await f()) return true; await Bun.sleep(100); } return false; };

describe.skipIf(!have)("a relaunched orchestrator", () => {
  test("is the same chair, and the Seat button will not start a second", async () => {
    expect((await h.asPerson("/seat/close", { root: h.dir })).ok).toBe(true);
    // A tab elsewhere keeps the tmux server (and its pane numbering) alive, so the new pane is not given the old one's id.
    await h.handTab(tmpdir(), "elsewhere");
    const old = await h.handTab(h.dir, "Orchestrator-orbit");
    expect((await h.asPerson("/seat/adopt", { root: h.dir, pane: old, powers: "assign" })).ok).toBe(true);
    expect((await status()).live).toBe(true);

    // The relay: the old window goes, a new one with the same name takes over, nobody adopts.
    await h.closeTab(old);
    const fresh = await h.handTab(h.dir, "Orchestrator-orbit");
    expect(fresh).not.toBe(old);
    expect(await settled(async () => (await status()).agent?.paneId === fresh)).toBe(true);
    expect((await status()).live).toBe(true);

    // The re-link carries no credential (it can only be handed over in an answer): the new session adopts once to get its own.
    const adopted = await h.asPerson("/seat/adopt", { root: h.dir, pane: fresh, powers: "assign" });
    expect(adopted.ok).toBe(true);
    expect((adopted as any).token).toMatch(/^st_/);

    const again = await h.asPerson("/seat/open", { root: h.dir });
    expect(again.ok).toBe(true);
    expect((again as any).already).toBe(true);
  });

  test("a deliberate stand-down stays down while the window runs, and Seat refuses", async () => {
    expect((await h.asPerson("/seat/close", { root: h.dir })).ok).toBe(true);
    expect((await status()).live).toBe(false);
    const r = await h.asPerson("/seat/open", { root: h.dir });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("already running");
  });
});
