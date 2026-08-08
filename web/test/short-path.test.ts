/*
 * The path under a checkout's name.
 *
 * The first attempt was `dir="rtl"`, to truncate from the left and keep the
 * end — which is the part that tells ten worktrees of one repository apart.
 * It did truncate from the left. It also MOVED the leading slash to the other
 * end, so `/home/you/code/app` was drawn as `home/you/code/app/`: a path that
 * does not exist, shown as if it did. Measured on screen, not reasoned about.
 *
 * So the shortening is done here instead, where it can be checked.
 */
import { describe, expect, it } from "bun:test";
import { shortPath } from "../src/lib/shortPath.ts";

describe("shortening a checkout's path", () => {
  it("keeps the leading slash when there is nothing to fold", () => {
    // The whole point of not using rtl.
    expect(shortPath("/opt/src/app")).toBe("/opt/src/app");
    expect(shortPath("/opt/src/app").startsWith("/")).toBe(true);
  });

  it("folds the home directory, which every row shares", () => {
    expect(shortPath("/home/you/code/app")).toBe("~/code/app");
    expect(shortPath("/Users/you/code/app")).toBe("~/code/app");
  });

  it("keeps the tail, which is what tells two worktrees apart", () => {
    // These differ only at the end; a truncation that cut the tail would draw
    // ten identical rows.
    const a = shortPath("/home/you/code/app-feature-one");
    const b = shortPath("/home/you/code/app-feature-two");
    expect(a).not.toBe(b);
    expect(a.endsWith("one")).toBe(true);
    expect(b.endsWith("two")).toBe(true);
  });

  it("leaves a path that is not under a home directory alone", () => {
    expect(shortPath("/var/lib/checkouts/app")).toBe("/var/lib/checkouts/app");
    // And does not mistake a directory merely CALLED home for the real one.
    expect(shortPath("/srv/home/app")).toBe("/srv/home/app");
  });

  it("survives the empty case rather than throwing at render time", () => {
    expect(shortPath("")).toBe("");
  });
});
