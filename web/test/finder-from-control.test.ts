/*
 * `{"cmd":"open","what":"finder"}` reaches the window as a `control` frame.
 * Which of those frames becomes a finder request is decided here, so it can be
 * asserted without a renderer.
 */
import { describe, expect, it } from "bun:test";
import type { ControlCmd } from "../../shared/types.ts";
import { finderFromControl } from "../src/lib/finderTarget.ts";

describe("which control frames open the finder", () => {
  it("a file frame asks for that file", () => {
    expect(finderFromControl({ cmd: "open", what: "finder", path: "/home/ana/notes/plan.md", kind: "file" }))
      .toEqual({ path: "/home/ana/notes/plan.md", kind: "file" });
  });

  it("a folder frame asks for the listing", () => {
    expect(finderFromControl({ cmd: "open", what: "finder", path: "/home/ana/notes", kind: "dir" }))
      .toEqual({ path: "/home/ana/notes", kind: "dir" });
  });

  it("every other command, including the other panels, asks for nothing", () => {
    const others: ControlCmd[] = [{ cmd: "open", what: "palette" }, { cmd: "open", what: "help" }, { cmd: "esc" }, { cmd: "view", to: "files" }];
    for (const c of others) expect(finderFromControl(c)).toBeNull();
  });

  it("a frame whose path is not absolute is dropped, whatever the server meant", () => {
    const bad = (path: unknown) => ({ cmd: "open", what: "finder", path, kind: "file" }) as unknown as ControlCmd;
    for (const p of ["plan.md", "~/plan.md", "", undefined, 3]) expect(finderFromControl(bad(p))).toBeNull();
  });

  it("an unknown kind falls back to a file, the safe reading of a spelling", () => {
    expect(finderFromControl({ cmd: "open", what: "finder", path: "/a/b", kind: "weird" } as unknown as ControlCmd))
      .toEqual({ path: "/a/b", kind: "file" });
  });
});
