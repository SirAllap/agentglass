// The /control body is untrusted input broadcast to every browser tab, so the
// validator is a trust boundary: a malformed or unknown command must resolve to
// null and never reach a client. These pin the closed sets it accepts.
import { describe, expect, test } from "bun:test";
import { parseControlCmd } from "../src/control.ts";

describe("parseControlCmd — view", () => {
  test("accepts every real view id", () => {
    for (const to of ["git", "diff", "pr", "docker", "term", "chat"]) {
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

describe("parseControlCmd — junk", () => {
  test("rejects non-objects and unknown commands", () => {
    for (const b of [null, undefined, 42, "view", [], { cmd: "nope" }, {}]) {
      expect(parseControlCmd(b as unknown)).toBeNull();
    }
  });
});
