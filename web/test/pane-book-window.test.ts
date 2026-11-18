import { describe, expect, test } from "bun:test";
import { bookPanes, bookedFor } from "../src/lib/paneWorktree.ts";

describe("bookedFor: a tab switch never reads the previous tab's pane", () => {
  const a = bookPanes([{ pane: "%1", active: true, dirs: ["/code/orbit-ORBIT-135"], agent: "sA" }]);
  test("the book filled for window A answers A", () => {
    expect(bookedFor(a, "@1", "@1", "")?.dirs[0]).toBe("/code/orbit-ORBIT-135");
  });
  test("the same book, asked for window B (unsplit, pane \"\"), answers nothing", () => {
    expect(bookedFor(a, "@1", "@2", "")).toBeUndefined();
    expect(bookedFor(a, "@1", "@2", "%1")).toBeUndefined();
  });
});
