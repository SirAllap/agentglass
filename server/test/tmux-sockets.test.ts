// Which tmux servers to look on, and each of them once.
//
// A client can name the same server three ways — no flag, `-L name`, `-S path`
// — and taking the known client's spelling alongside a directory listing put
// one server in the list twice. Every pane on it then came back twice, which in
// the UI reads as two identical panes to choose between.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "agx-sock-"));
const dir = join(base, `tmux-${process.getuid?.() ?? 0}`);
mkdirSync(dir, { recursive: true });
for (const n of ["default", "work", "stray"]) writeFileSync(join(dir, n), "");

const prev = process.env.TMUX_TMPDIR;
let tmuxctl: typeof import("../src/tmuxctl.ts");
beforeAll(async () => {
  process.env.TMUX_TMPDIR = base;
  tmuxctl = await import("../src/tmuxctl.ts");
});
afterAll(() => { if (prev === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prev; });

const paths = (rows: string[][]) => rows.map((r) => r[1]);

describe("finding the servers", () => {
  test("every socket in the directory, addressed by path", () => {
    const got = tmuxctl.tmuxSockets();
    expect(got.every((r) => r[0] === "-S")).toBe(true);
    expect(paths(got).sort()).toEqual([join(dir, "default"), join(dir, "stray"), join(dir, "work")]);
  });

  test("the three spellings of one server collapse to one entry", () => {
    for (const known of [[], ["-L", "default"], ["-S", join(dir, "default")]]) {
      const got = paths(tmuxctl.tmuxSockets(known));
      expect(got.filter((p) => p === join(dir, "default")).length).toBe(1);
      expect(got.length).toBe(3);
    }
  });

  test("the client's own server is looked at first", () => {
    // Not cosmetic: it is the server the user is demonstrably attached to, so
    // its panes are the likeliest match for whatever is asking.
    expect(paths(tmuxctl.tmuxSockets(["-L", "work"]))[0]).toBe(join(dir, "work"));
    expect(paths(tmuxctl.tmuxSockets([]))[0]).toBe(join(dir, "default"));
  });

  test("a client on a socket outside the directory is still included", () => {
    const odd = "/run/user/1000/tmux-elsewhere";
    const got = paths(tmuxctl.tmuxSockets(["-S", odd]));
    expect(got[0]).toBe(odd);
    expect(got.length).toBe(4);
  });

  test("no socket directory is no servers, not a throw", () => {
    process.env.TMUX_TMPDIR = join(base, "nothing-here");
    expect(tmuxctl.tmuxSockets()).toEqual([]);
    process.env.TMUX_TMPDIR = base;
  });
});
