/*
 * Handing a folder from the palette to the Files view.
 *
 * The palette can be open over anything — a terminal, a diff, the dashboard —
 * and a folder chosen in it is a PLACE, not a document: there is nothing to
 * raise over the screen for a directory, so the answer is the tree, walked
 * there. Files may not even have been opened in this session, so this cannot be
 * a prop; it is a one-slot request the view picks up when it is shown.
 *
 * Two rules carry the weight, and both were bugs waiting:
 *  - the checkout travels with the path, or a folder of the same name in the
 *    wrong worktree gets revealed and the search looks like it lied;
 *  - the counter, not the path, is what makes it a new request — otherwise
 *    asking for the same folder twice does nothing the second time.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const load = async () =>
  (await import(`../src/lib/filesReveal.ts?t=${Math.random()}`)) as typeof import("../src/lib/filesReveal.ts");

const A = "/home/x/code/app";
const B = "/home/x/code/app-wt";

let mod: typeof import("../src/lib/filesReveal.ts");
beforeEach(async () => { mod = await load(); });

describe("the request", () => {
  it("is absent until something asks", () => {
    expect(mod.filesReveal()).toBeNull();
  });

  it("carries the checkout as well as the path", () => {
    mod.requestFilesReveal(A, "docs/projects/guest-checkout-v2");
    expect(mod.filesReveal()).toMatchObject({ root: A, dir: "docs/projects/guest-checkout-v2" });
  });

  it("counts up, so the same folder twice is two requests", () => {
    // A path-keyed consumer would decide nothing had changed: walk away in the
    // tree, search for it again, and you stay where you were.
    mod.requestFilesReveal(A, "docs");
    const first = mod.filesReveal()!.n;
    mod.requestFilesReveal(A, "docs");
    expect(mod.filesReveal()!.n).toBe(first + 1);
  });

  it("replaces the pending one rather than queueing", () => {
    // Only the last place asked for is a place anybody still wants to go.
    mod.requestFilesReveal(A, "docs");
    mod.requestFilesReveal(B, "src/billing");
    expect(mod.filesReveal()).toMatchObject({ root: B, dir: "src/billing" });
  });
});

describe("who hears about it", () => {
  it("tells every subscriber", () => {
    let a = 0, b = 0;
    mod.subscribeFilesReveal(() => a++);
    mod.subscribeFilesReveal(() => b++);
    mod.requestFilesReveal(A, "docs");
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("stops telling one that unsubscribed", () => {
    let n = 0;
    const off = mod.subscribeFilesReveal(() => n++);
    mod.requestFilesReveal(A, "docs");
    off();
    mod.requestFilesReveal(A, "src");
    expect(n).toBe(1);
  });

  it("lets a view that was not mounted yet read the request when it arrives", () => {
    // The whole reason this is a store: Files may never have been opened, so
    // there is nobody listening at the moment the palette asks.
    mod.requestFilesReveal(A, "docs/projects/guest-checkout-v2");
    let seen: string | null = null;
    mod.subscribeFilesReveal(() => { seen = mod.filesReveal()!.dir; });
    // Mounting late still finds the request waiting.
    expect(mod.filesReveal()!.dir).toBe("docs/projects/guest-checkout-v2");
    expect(seen).toBeNull();
  });
});
