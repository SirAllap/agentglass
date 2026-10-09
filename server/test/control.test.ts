// The /control body is untrusted input broadcast to every browser tab, so the
// validator is a trust boundary: a malformed or unknown command must resolve to
// null and never reach a client. These pin the closed sets it accepts.
import { describe, expect, test } from "bun:test";
import { parseControlCmd, controlId, UI_MAX_LEVEL } from "../src/control.ts";
import { UI_ACTIONS, parseUi } from "../../shared/uiActions.ts";

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

describe("parseControlCmd — the ui wire shape", () => {
  const ui = (id: unknown, args?: unknown) => parseControlCmd({ cmd: "ui", do: id, args });

  test("a registry id with valid args is a ui command, carrying only the args it names", () => {
    expect(ui("settings.open", { page: "appearance" })).toEqual({ cmd: "ui", do: "settings.open", args: { page: "appearance" } });
    expect(ui("settings.open", { page: "diff", row: "wrap-long-lines", junk: "x" })).toEqual({ cmd: "ui", do: "settings.open", args: { page: "diff", row: "wrap-long-lines" } });
    expect(ui("project.picker")).toEqual({ cmd: "ui", do: "project.picker", args: {} });
    expect(ui("machine.open", { tab: "ports" })).toEqual({ cmd: "ui", do: "machine.open", args: { tab: "ports" } });
  });

  test("an id that is not in the registry is refused, whatever it looks like", () => {
    for (const id of ["settings.set", "settings.get", "pr.merge", "", "__proto__", "constructor", "toString", "hasOwnProperty", 7, null, undefined, {}]) {
      expect(ui(id, {})).toBeNull();
    }
    expect(parseControlCmd({ cmd: "ui" })).toBeNull();
  });

  test("args are closed: a wrong enum, a missing required field or a non-object are refused", () => {
    expect(ui("settings.open", { page: "secrets" })).toBeNull();
    expect(ui("settings.open", {})).toBeNull();
    expect(ui("settings.open")).toBeNull();
    expect(ui("settings.open", "appearance")).toBeNull();
    expect(ui("settings.open", ["appearance"])).toBeNull();
    expect(ui("settings.open", { page: "appearance", row: "has space" })).toBeNull();
    expect(ui("settings.open", { page: "appearance", row: 3 })).toBeNull();
    expect(ui("machine.open", { tab: "kill" })).toBeNull();
    expect(ui("git.modal", { which: "rebase" })).toBeNull();
    expect(ui("git.modal", { which: "rescue" })).toBeNull();
  });

  test("paths are spellings: absolute for a root, relative and downward for a file under it", () => {
    expect(ui("peek.file", { root: "/home/ana/code/orbit", path: "docs/plan.md" })).toEqual({ cmd: "ui", do: "peek.file", args: { root: "/home/ana/code/orbit", path: "docs/plan.md" } });
    for (const path of ["/etc/passwd", "../x", "a/../../x", "a//b", "./a", "", "a\0b", "a\nb"]) {
      expect(ui("peek.file", { root: "/home/ana/code/orbit", path })).toBeNull();
    }
    for (const root of ["orbit", "/home/ana/../bob", "/home//ana", "~/orbit"]) {
      expect(ui("bench.file", { root, path: "a.md" })).toBeNull();
    }
  });

  test("a git ref cannot read as an option or a range", () => {
    expect(ui("git.compare", { base: "origin/main" })).toEqual({ cmd: "ui", do: "git.compare", args: { base: "origin/main" } });
    for (const base of ["--output=x", "-b", "a..b", "a b", "", "a\nb", "x".repeat(201)]) expect(ui("git.compare", { base })).toBeNull();
  });

  test("a finder through ui carries the kind the spelling implies, like the old spelling", () => {
    expect(ui("finder.open", { path: "/home/ana/notes/" })).toEqual({ cmd: "ui", do: "finder.open", args: { path: "/home/ana/notes", kind: "dir" } });
    expect(ui("finder.open", { path: "/home/ana/notes/plan.md" })).toEqual({ cmd: "ui", do: "finder.open", args: { path: "/home/ana/notes/plan.md", kind: "file" } });
    expect(ui("finder.open", { path: "notes" })).toBeNull();
    // Said outright, it is taken; anything else falls back to the spelling.
    expect(ui("finder.open", { path: "/home/ana/notes", kind: "dir" })).toEqual({ cmd: "ui", do: "finder.open", args: { path: "/home/ana/notes", kind: "dir" } });
    expect(ui("finder.open", { path: "/home/ana/notes", kind: "weird" })).toEqual({ cmd: "ui", do: "finder.open", args: { path: "/home/ana/notes", kind: "file" } });
  });

  test("a level above the one this server accepts is refused, and so is an id with no level", () => {
    const registry = {
      look: { level: 1, kind: "open", surface: "x", args: {} },
      change: { level: 2, kind: "change", surface: "x", args: {} },
      effect: { level: 3, kind: "external", surface: "x", args: {} },
    } as const;
    expect(parseUi(registry, "look", {}, UI_MAX_LEVEL)).not.toBeNull();
    expect(parseUi(registry, "change", {}, UI_MAX_LEVEL)).not.toBeNull();
    expect(parseUi(registry, "change", {}, 1)).toBeNull();
    expect(parseUi(registry, "effect", {}, UI_MAX_LEVEL)).toBeNull();
    expect(UI_MAX_LEVEL).toBe(2);
    // No level at all is level 3: refused, not "no limit".
    const unlevelled = { oops: { kind: "open", surface: "x", args: {} } } as never;
    expect(parseUi(unlevelled, "oops", {}, UI_MAX_LEVEL)).toBeNull();
  });

  test("only the settings write is level 2; every other entry is level 1", () => {
    for (const [id, d] of Object.entries(UI_ACTIONS)) expect(d.level, id).toBe(id === "settings.set" ? 2 : 1);
  });
});

describe("parseControlCmd — the old spellings are registry entries", () => {
  test("each legacy body parses to the same entry its ui spelling does", () => {
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ cmd: "view", to: "git" }, { cmd: "ui", do: "view.open", args: { to: "git" } }],
      [{ cmd: "open", what: "help" }, { cmd: "ui", do: "panel.open", args: { what: "help" } }],
      [{ cmd: "open", what: "finder", path: "/a/b" }, { cmd: "ui", do: "finder.open", args: { path: "/a/b" } }],
      [{ cmd: "chat", do: "new" }, { cmd: "ui", do: "chat.new", args: {} }],
      [{ cmd: "zoom", dir: -1 }, { cmd: "ui", do: "zoom.step", args: { dir: -1 } }],
      [{ cmd: "theme", name: "nord" }, { cmd: "ui", do: "theme.set", args: { name: "nord" } }],
      [{ cmd: "esc" }, { cmd: "ui", do: "esc.peel", args: {} }],
      [{ cmd: "workspace" }, { cmd: "ui", do: "workspace.toggle", args: {} }],
    ];
    for (const [old, wire] of pairs) {
      const a = parseControlCmd(old)!;
      const b = parseControlCmd(wire)!;
      expect(a, JSON.stringify(old)).not.toBeNull();
      expect(b, JSON.stringify(wire)).not.toBeNull();
      expect(controlId(a), JSON.stringify(old)).toBe(controlId(b));
    }
  });

  test("the audit id is the registry id, for either spelling, and never carries a value", () => {
    expect(controlId(parseControlCmd({ cmd: "view", to: "git" })!)).toBe("view.open");
    expect(controlId(parseControlCmd({ cmd: "open", what: "finder", path: "/secret/place" })!)).toBe("finder.open");
    expect(controlId(parseControlCmd({ cmd: "open", what: "stats" })!)).toBe("panel.open");
    expect(controlId(parseControlCmd({ cmd: "ui", do: "settings.open", args: { page: "about" } })!)).toBe("settings.open");
  });

  test("the closed sets are the registry's: every view, panel and chat verb comes from it", () => {
    for (const to of UI_ACTIONS["view.open"].args.to.values) expect(parseControlCmd({ cmd: "view", to })).not.toBeNull();
    for (const what of UI_ACTIONS["panel.open"].args.what.values) expect(parseControlCmd({ cmd: "open", what })).not.toBeNull();
  });

  test("a theme name can no longer be anything: it is a slug", () => {
    expect(parseControlCmd({ cmd: "theme", name: "github-dark-dimmed" })).not.toBeNull();
    expect(parseControlCmd({ cmd: "theme", name: "x y" })).toBeNull();
    expect(parseControlCmd({ cmd: "theme", name: "x".repeat(65) })).toBeNull();
  });
});
