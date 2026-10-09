// The /control body is untrusted input broadcast to every browser tab, so the
// validator is a trust boundary: a malformed or unknown command must resolve to
// null and never reach a client. These pin the closed sets it accepts.
import { describe, expect, test } from "bun:test";
import { parseControlCmd } from "../src/control.ts";

describe("parseControlCmd — view", () => {
  test("accepts every real view id", () => {
    for (const to of ["dash", "git", "diff", "pr", "tasks", "docker", "term", "chat", "browser", "files", "lantern", "seat"]) {
      expect(parseControlCmd({ cmd: "view", to })).toEqual({ cmd: "view", to } as never);
    }
  });

  test("rejects an unknown or missing view id", () => {
    expect(parseControlCmd({ cmd: "view", to: "settings" })).toBeNull();
    expect(parseControlCmd({ cmd: "view" })).toBeNull();
    expect(parseControlCmd({ cmd: "view", to: 3 })).toBeNull();
  });
});

describe("parseControlCmd — workspace", () => {
  test("absent open means toggle", () => {
    expect(parseControlCmd({ cmd: "workspace" })).toEqual({ cmd: "workspace" });
  });

  test("a boolean open sets it; anything else is dropped", () => {
    expect(parseControlCmd({ cmd: "workspace", open: true })).toEqual({ cmd: "workspace", open: true });
    expect(parseControlCmd({ cmd: "workspace", open: false })).toEqual({ cmd: "workspace", open: false });
    expect(parseControlCmd({ cmd: "workspace", open: "yes" })).toBeNull();
    expect(parseControlCmd({ cmd: "workspace", open: 1 })).toBeNull();
  });
});

describe("parseControlCmd — esc", () => {
  test("needs no fields", () => {
    expect(parseControlCmd({ cmd: "esc" })).toEqual({ cmd: "esc" });
  });
});

describe("parseControlCmd — open", () => {
  test("accepts every panel the keyboard opens", () => {
    for (const what of ["stats", "skills", "search", "help", "palette"]) {
      expect(parseControlCmd({ cmd: "open", what })).toEqual({ cmd: "open", what } as never);
    }
  });

  test("rejects an unknown panel", () => {
    expect(parseControlCmd({ cmd: "open", what: "settings" })).toBeNull();
    expect(parseControlCmd({ cmd: "open" })).toBeNull();
  });
});

describe("parseControlCmd — open finder", () => {
  const ok = (path: unknown) => parseControlCmd({ cmd: "open", what: "finder", path });

  test("a file path is a file; a trailing slash is a folder", () => {
    expect(ok("/home/ana/notes/plan.md")).toEqual({ cmd: "open", what: "finder", path: "/home/ana/notes/plan.md", kind: "file" });
    expect(ok("/home/ana/notes/")).toEqual({ cmd: "open", what: "finder", path: "/home/ana/notes", kind: "dir" });
    expect(ok("/")).toEqual({ cmd: "open", what: "finder", path: "/", kind: "dir" });
  });

  test("a path that does not exist is still a command: the finder owns that state", () => {
    expect(ok("/home/ana/not-there.md")).not.toBeNull();
  });

  test("relative, missing and non-string paths are refused", () => {
    for (const p of ["notes/plan.md", "./plan.md", "~/plan.md", "", undefined, null, 7, ["/a"], { a: 1 }]) expect(ok(p)).toBeNull();
    expect(parseControlCmd({ cmd: "open", what: "finder" })).toBeNull();
  });

  test("NUL and other control characters are refused", () => {
    for (const p of ["/home/ana/plan.md\0.png", "/home/ana/a\nb.md", "/home/ana/a\rb.md", "/home/ana/\u007f.md"]) expect(ok(p)).toBeNull();
  });

  test("a path that is not already normalized is refused", () => {
    for (const p of ["/home/ana/../bob/plan.md", "/home/ana/./plan.md", "/home//ana/plan.md", "//home/ana", "/home/ana//", "/.."]) expect(ok(p)).toBeNull();
  });

  test("a non-POSIX spelling is refused", () => {
    for (const p of ["C:\\Users\\ana\\plan.md", "gh:acme/orbit", "file:///home/ana/plan.md"]) expect(ok(p)).toBeNull();
  });

  test("a path longer than PATH_MAX is refused", () => {
    expect(ok("/" + "a".repeat(4096))).toBeNull();
    expect(ok("/" + "a".repeat(4000))).not.toBeNull();
  });

  test("the plain panels are unchanged by it", () => {
    expect(parseControlCmd({ cmd: "open", what: "palette", path: "/home/ana/plan.md" })).toEqual({ cmd: "open", what: "palette" });
  });
});

describe("parseControlCmd — theme", () => {
  test("a name pins one palette", () => {
    expect(parseControlCmd({ cmd: "theme", name: "forest" })).toEqual({ cmd: "theme", name: "forest" });
  });

  test("a direction steps the list", () => {
    expect(parseControlCmd({ cmd: "theme", dir: 1 })).toEqual({ cmd: "theme", dir: 1 });
    expect(parseControlCmd({ cmd: "theme", dir: -1 })).toEqual({ cmd: "theme", dir: -1 });
  });

  test("name wins when both are sent", () => {
    expect(parseControlCmd({ cmd: "theme", name: "nord", dir: 1 })).toEqual({ cmd: "theme", name: "nord" });
  });

  test("neither, an empty name, or a bad direction is not a command", () => {
    expect(parseControlCmd({ cmd: "theme" })).toBeNull();
    expect(parseControlCmd({ cmd: "theme", name: "" })).toBeNull();
    expect(parseControlCmd({ cmd: "theme", dir: 2 })).toBeNull();
    expect(parseControlCmd({ cmd: "theme", dir: 0 })).toBeNull();
  });
});

describe("parseControlCmd — zoom", () => {
  test("accepts in, out, and reset", () => {
    expect(parseControlCmd({ cmd: "zoom", dir: 1 })).toEqual({ cmd: "zoom", dir: 1 });
    expect(parseControlCmd({ cmd: "zoom", dir: -1 })).toEqual({ cmd: "zoom", dir: -1 });
    expect(parseControlCmd({ cmd: "zoom", dir: 0 })).toEqual({ cmd: "zoom", dir: 0 });
  });

  test("rejects any other direction", () => {
    expect(parseControlCmd({ cmd: "zoom", dir: 2 })).toBeNull();
    expect(parseControlCmd({ cmd: "zoom" })).toBeNull();
  });
});

describe("parseControlCmd — chat", () => {
  test("accepts the one chat verb", () => {
    expect(parseControlCmd({ cmd: "chat", do: "new" })).toEqual({ cmd: "chat", do: "new" });
  });

  test("rejects every verb outside the closed set", () => {
    for (const d of ["", "compact", "send", "/compact", "delete", 1, null, undefined, {}]) {
      expect(parseControlCmd({ cmd: "chat", do: d })).toBeNull();
    }
    expect(parseControlCmd({ cmd: "chat" })).toBeNull();
  });
});

describe("parseControlCmd — junk", () => {
  test("rejects non-objects and unknown commands", () => {
    for (const b of [null, undefined, 42, "view", [], { cmd: "nope" }, {}]) {
      expect(parseControlCmd(b as unknown)).toBeNull();
    }
  });

  test("a read-only view is on the list like any other", () => {
    /* The understudy shows a scorecard and commands nothing, so there is a
       temptation to leave it off a list whose whole job is to keep untrusted
       input away from things that act. Off the list it is not safer, it is
       broken: the rail draws the tab, the keyboard opens it with one letter,
       and only the external controller is told it does not exist. What this
       list restricts is what may be SHOWN, and every view in the rail may be
       shown. See web/test/understudy-view-registration.test.ts, which pins all
       four registration points against each other. */
    expect(parseControlCmd({ cmd: "view", to: "seat" })).toEqual({ cmd: "view", to: "seat" });
    /* And the reverse, for a view that was retired: `understudy` left the rail
       on 2026-09-08 and left this list with it, so an external controller is
       refused rather than opening a tab whose body no longer exists. */
    expect(parseControlCmd({ cmd: "view", to: "understudy" })).toBeNull();
  });

  test("the browser view can be opened too — an agent driving it needs it mounted", () => {
    expect(parseControlCmd({ cmd: "view", to: "browser" })).toEqual({ cmd: "view", to: "browser" });
    // And the list is still a list: a view that is not on it stays off. (`dash`
    // joined the list in 0.8, so the off-list example is a name that never will.)
    expect(parseControlCmd({ cmd: "view", to: "settings" })).toBeNull();
  });
});
