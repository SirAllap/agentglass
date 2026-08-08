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
/*
 * `$TMUX` is owned here for the same reason TMUX_TMPDIR is: it decides the
 * answer this file is about.
 *
 * A bare `tmux` goes to the socket `$TMUX` names, ahead of TMUX_TMPDIR —
 * measured on 3.6a, see `inheritedSocket`. Agents in this repo run inside the
 * developer's tmux, so an inherited `$TMUX` made `[]` mean *his* server here,
 * and the fixture's `default` became a fourth entry that never matched. Cleared
 * rather than worked around, because every test below except the last is about
 * a machine that is not inside tmux; the last one puts it back deliberately.
 */
const prevTmux = process.env.TMUX;
let tmuxctl: typeof import("../src/tmuxctl.ts");
beforeAll(async () => {
  process.env.TMUX_TMPDIR = base;
  delete process.env.TMUX;
  tmuxctl = await import("../src/tmuxctl.ts");
});
afterAll(() => {
  if (prev === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prev;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
});

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

  test("the same server named two ways resolves to one key", () => {
    /*
     * Load-bearing twice over, and both are cases where the two halves learned
     * the socket from different places: a phone's attach carries the resolved
     * `-S /path` off `tmuxSockets`, while the desk's client is read from its own
     * argv and a plain `tmux` names no socket at all. Comparing those arrays —
     * to route a frame to the phone on a window, or to see whether the desk has
     * claimed one — never matches, on the very server both are sitting on.
     */
    const same = [[], ["-L", "default"], ["-S", join(dir, "default")]];
    for (const spelling of same) expect(tmuxctl.socketPath(spelling)).toBe(join(dir, "default"));
    expect(tmuxctl.socketPath(["-L", "work"])).not.toBe(tmuxctl.socketPath([]));
  });

  /*
   * …and the spellings of a `-S` path, which is the half that is not about
   * flags at all.
   *
   * `-S` carries whatever text was on a client's command line, and `/./`, `//`
   * and `/../` are all the same file to the kernel and three different strings
   * to a `===`. This function is what `tmuxSockets` dedups on and what
   * `claimKey` is built from, so an un-normalised `-S` puts one server in the
   * list twice — the duplicate-panes bug this whole file exists for — and lets
   * a claim on a window be missed by the half that spelt the socket the other
   * way.
   *
   * Lexical only, deliberately: no realpath here, so a socket file appearing or
   * vanishing cannot silently rename the server it identifies. Resolving
   * symlinks belongs to the comparison in `tmuxSocketAllowed`; see `sameSocket`.
   */
  test("one `-S` path spelt several ways is one key", () => {
    // Built by string, never by `join` — `join` normalises as it goes, so a
    // fixture built with it would assert that `join` works and pass with the
    // normalisation under test deleted.
    const canonical = join(dir, "default");
    const uid = process.getuid?.() ?? 0;
    for (const spelling of [
      `/${dir}/default`,                       // //tmp/…/tmux-<uid>/default
      `${dir}/./default`,
      `${dir}/../tmux-${uid}/default`,
      `${dir}//default`,
    ]) expect(tmuxctl.socketPath(["-S", spelling]), spelling).toBe(canonical);
  });

  /*
   * And the fourth spelling, which is not a spelling at all.
   *
   * Inside a tmux, `$TMUX` names the socket outright and a bare `tmux` goes
   * there — TMUX_TMPDIR is not consulted. Measured on 3.6a from a shell inside
   * a live server, with an empty directory to hide behind:
   *
   *   TMUX_TMPDIR=/tmp/agx-probe-empty tmux list-sessions  -> his real sessions
   *   env -u TMUX  (same command)                          -> error connecting
   *                                                           to that directory
   *
   * `-S` and `-L` do override it, which is why they are checked first and why
   * the suites that name their own server are untouched by this.
   */
  test("inside a tmux, no flag means the server this process is already in", () => {
    const inside = join(base, "someone-elses", "default");
    process.env.TMUX = `${inside},4242,0`;
    try {
      expect(tmuxctl.socketPath([])).toBe(inside);
      // Only the flagless spelling. A named socket is a named socket.
      expect(tmuxctl.socketPath(["-L", "work"])).toBe(join(dir, "work"));
      expect(tmuxctl.socketPath(["-S", join(dir, "default")])).toBe(join(dir, "default"));
    } finally { delete process.env.TMUX; }
  });

  test("no socket directory is no servers, not a throw", () => {
    process.env.TMUX_TMPDIR = join(base, "nothing-here");
    expect(tmuxctl.tmuxSockets()).toEqual([]);
    process.env.TMUX_TMPDIR = base;
  });
});
