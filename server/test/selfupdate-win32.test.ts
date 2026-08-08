// The self-updater shells out to bash against a POSIX-only self-update.sh, so it
// cannot run on a stock Windows box (#189). Rather than offer an update button
// that spawns a bash which isn't there, updateStatus() reports an honest block on
// win32 — and startUpdate() refuses on any blocked status before it reaches the
// spawn. This pins the platform gate that decides it.
import { beforeAll, describe, expect, test } from "bun:test";

// selfupdate.ts reads AGENTGLASS_UPDATE_SRC into a module-level const at load, so
// a plain top-level import here would fix SRC for the whole process from whatever
// env happened to be set. A cache-busted import gives this file its own instance.
// release-notes.test.ts takes one too now, rather than relying on import order.
let windowsUpdateBlock: (platform?: string) => string | null;
beforeAll(async () => {
  ({ windowsUpdateBlock } = await import(`../src/selfupdate.ts?u=${Math.random()}`));
});

describe("windowsUpdateBlock", () => {
  test("blocks self-update on win32 with an actionable message", () => {
    const msg = windowsUpdateBlock("win32");
    expect(msg).toBeTruthy();
    expect(msg).toContain("Windows");
    expect(msg!.toLowerCase()).toContain("release"); // points at the real way to update
  });

  test("does not block on linux or macOS", () => {
    expect(windowsUpdateBlock("linux")).toBeNull();
    expect(windowsUpdateBlock("darwin")).toBeNull();
  });
});
