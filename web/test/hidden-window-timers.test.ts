/*
 * Two renderer timers used to poll the server while the window was hidden.
 * Source-level (no DOM in these suites): each must go through the house
 * helper `intervalWhileVisible` and hold no bare `setInterval`.
 */
import { describe, expect, test } from "bun:test";

const src = (rel: string) => Bun.file(new URL(`../src/${rel}`, import.meta.url)).text();

describe("timers that stop while the window is hidden", () => {
  test("the update progress poll", async () => {
    const t = await src("components/UpdateToast.tsx");
    expect(t).toContain("intervalWhileVisible(");
    expect(t).not.toContain("setInterval(");
  });
  test("the setup folder scan poll", async () => {
    const t = await src("components/setup/ProjectFinder.tsx");
    expect(t).toContain("intervalWhileVisible(");
    expect(t).not.toContain("setInterval(");
  });
});
