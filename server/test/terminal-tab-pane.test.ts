/*
 * The tmux frame names the pane the tab is on — split or not.
 *
 * `panes` is the geometry the split UI hovers over, and it is empty for a window
 * that is not split, which is every tab a worker runs in. With no id on the
 * frame, the bar over that tab looked its row up in `/agents/named` by the
 * terminal session's own key (`t12-…`, a name only the browser knows), and
 * every poll was answered 400 — so the bar never drew at all.
 *
 * Asserted against a booted server and a real client, not the helper: the
 * helper test in tmux-panes.test.ts pins what the fields mean, and only this
 * can tell whether the sweep actually puts them on the wire.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;

beforeAll(async () => { if (have) h = await startHarness("wtpane"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** The first tmux frame this shell is sent, which is the window it is on. */
async function firstFrame(root: string): Promise<Record<string, any>> {
  const ws = new WebSocket(`${h.base.replace("http", "ws")}/terminal/pty?token=${encodeURIComponent(MACHINE)}&root=${encodeURIComponent(root)}`);
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no tmux frame within 20s")), 20_000);
      ws.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        const f = JSON.parse(e.data) as Record<string, any>;
        if (f.t !== "tmux" || f.active !== true) return;
        clearTimeout(t);
        resolve(f);
      });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("the socket refused")); });
    });
  } finally {
    ws.close();
  }
}

describe.skipIf(!have)("the pane a tab is on, as the client is told", () => {
  test("an unsplit window — every worker's tab — still names its pane", async () => {
    const f = await firstFrame(h.wt);
    // The geometry the split UI draws on is empty on purpose: one pane
    // covering the window is nothing to choose between.
    expect(f.panes).toEqual([]);
    // The id is tmux's own, which is what /agents/named accepts.
    expect(f.pane).toMatch(/^%\d+$/);
  }, 40_000);
});
