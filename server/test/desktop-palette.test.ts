/**
 * "System" wears the desktop's own palette where the desktop publishes one, and
 * nothing changes anywhere else.
 *
 * The fixture is the shape of a real Omarchy `colors.toml` — a flat list of
 * `key = "value"` with a mode, an accent, four backgrounds, the foregrounds and
 * the terminal colours — with invented values.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopTheme, parseColors, mix } from "../../shared/desktopPalette.ts";
import { desktopPalette, watchDesktopPalette, __forgetDesktopPalette } from "../src/desktopPalette.ts";

const COLORS = `mode = "dark"

accent = "#7aa2f7"
selection = "#2a3350"
muted = "#3b4466"

background = "#1a1b26"
dark_background = "#15161e"
lighter_background = "#20222e"

foreground = "#c0caf5"
bright_foreground = "#e6ebff"

red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
cyan = "#7dcfff"
blue = "#7aa2f7"
magenta = "#bb9af7"

bright_red = "#ff8fa3"
bright_green = "#b5e08a"
`;

describe("the palette, as this app's tokens", () => {
  test("a flat colors.toml is read, and an odd line does not lose the rest", () => {
    const c = parseColors(COLORS + "\nthis line is not a pair\nbrown = \"#6b5540\" # trailing note\n");
    expect(c.background).toBe("#1a1b26");
    expect(c.brown).toBe("#6b5540");
    expect(c.mode).toBe("dark");
  });

  test("surfaces, text, accent and signals come from what the desktop names", () => {
    const t = desktopTheme(parseColors(COLORS), "Orbit Night")!;
    expect(t.name).toBe("Orbit Night");
    expect(t.dark).toBe(true);
    expect(t.vars["--bg"]).toBe("#1a1b26");
    expect(t.vars["--bg2"]).toBe("#20222e");
    expect(t.vars["--bg3"]).toBe("#2a3350");
    expect(t.vars["--bg4"]).toBe("#3b4466");
    expect(t.vars["--text"]).toBe("#e6ebff");
    expect(t.vars["--text2"]).toBe("#c0caf5");
    expect(t.vars["--primary"]).toBe("#7aa2f7");
    expect(t.vars["--error"]).toBe("#f7768e");
    expect(t.vars["--success"]).toBe("#9ece6a");
  });

  test("what the desktop does not name is mixed from what it does, never invented", () => {
    const bare = desktopTheme({ background: "#000000", foreground: "#ffffff" }, "Bare")!;
    expect(bare.vars["--bg2"]).toBe(mix("#000000", "#ffffff", 0.06));
    expect(bare.vars["--primary"]).toBe("#ffffff");
  });

  test("the terminal gets the desktop's sixteen when they are all there", () => {
    const t = desktopTheme(parseColors(COLORS), "x")!;
    expect(t.ansi?.red).toBe("#f7768e");
    expect(t.ansi?.brightRed).toBe("#ff8fa3");
    /* One named bright missing falls back to its base, not to a guess. */
    expect(t.ansi?.brightBlue).toBe("#7aa2f7");
  });

  test("a light desktop stays light", () => {
    expect(desktopTheme({ mode: "light", background: "#ffffff", foreground: "#111111" }, "x")!.dark).toBe(false);
  });

  test("no background or no foreground is no palette", () => {
    expect(desktopTheme({ foreground: "#fff" }, "x")).toBeNull();
    expect(desktopTheme({ background: "#000" }, "x")).toBeNull();
  });
});

describe("where the desktop keeps it", () => {
  const prior = { home: process.env.HOME, state: process.env.XDG_STATE_HOME };
  let home = "";
  /* Where Omarchy stages the theme: under HOME, whatever XDG_STATE_HOME says. */
  let root = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agx-desk-"));
    root = join(home, ".local", "state");
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
    __forgetDesktopPalette();
  });
  /* Here rather than at the end of each test, so a failed assertion does not
     leave its directory behind. */
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  afterAll(() => {
    if (prior.home === undefined) delete process.env.HOME; else process.env.HOME = prior.home;
    if (prior.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior.state;
    __forgetDesktopPalette();
  });

  test("a desktop that publishes nothing answers null — the whole cost elsewhere", () => {
    expect(desktopPalette()).toBeNull();
  });

  test("Omarchy's staged theme is read and named the way its menu names it", () => {
    const dir = join(root, "omarchy", "current");
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "colors.toml"), COLORS);
    writeFileSync(join(dir, "theme.name"), "orbit-night\n");
    const p = desktopPalette()!;
    expect(p.source).toBe("omarchy");
    expect(p.name).toBe("Orbit Night");
    expect(p.theme.vars["--bg"]).toBe("#1a1b26");
  });

  /* Omarchy's theme switch writes to $HOME/.local/state/omarchy/current and
     never reads XDG_STATE_HOME. An instance started with its own
     XDG_STATE_HOME — the way an isolated second copy of the app is run — read
     an empty directory there, answered null, and offered no Omarchy mode on a
     machine that was wearing an Omarchy theme. */
  test("an XDG_STATE_HOME moved elsewhere does not hide the desktop's palette", () => {
    const dir = join(root, "omarchy", "current");
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "colors.toml"), COLORS);
    writeFileSync(join(dir, "theme.name"), "orbit-night");
    const elsewhere = mkdtempSync(join(tmpdir(), "agx-desk-state-"));
    process.env.XDG_STATE_HOME = elsewhere;
    try { expect(desktopPalette()?.name).toBe("Orbit Night"); }
    finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });

  test("a switch on the desktop changes the stamp a client repaints on", () => {
    const dir = join(root, "omarchy", "current");
    mkdirSync(join(dir, "theme"), { recursive: true });
    const file = join(dir, "theme", "colors.toml");
    writeFileSync(file, COLORS);
    writeFileSync(join(dir, "theme.name"), "orbit-night");
    const first = desktopPalette()!.stamp;
    writeFileSync(file, COLORS.replace("#1a1b26", "#0b0c10"));
    writeFileSync(join(dir, "theme.name"), "acme-dusk");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const second = desktopPalette()!;
    expect(second.stamp).not.toBe(first);
    expect(second.name).toBe("Acme Dusk");
    expect(second.theme.vars["--bg"]).toBe("#0b0c10");
  });
});

import { rebuildMark } from "../src/desktopPalette.ts";

describe("the desktop's mark, rebuilt from geometry", () => {
  const MARK = `<svg fill="none" height="10" viewBox="0 0 40 10" width="40" xmlns="http://www.w3.org/2000/svg"><g fill="#000"><path clip-rule="evenodd" d="m0 0h10v10h-10z" fill-rule="evenodd"/><path d="m20 0h10v10h-10z"/></g></svg>`;

  test("keeps the view box and every outline, filled with the text colour", () => {
    const out = rebuildMark(MARK)!;
    expect(out).toContain('viewBox="0 0 40 10"');
    expect(out).toContain('fill="currentColor"');
    expect(out.match(/<path /g)?.length).toBe(2);
    expect(out).toContain('fill-rule="evenodd"');
  });

  test("nothing but geometry reaches the page", () => {
    const hostile = MARK
      .replace("<g ", '<script>alert(1)</script><g onload="alert(2)" ')
      .replace('d="m20 0h10v10h-10z"', 'd="m20 0h10v10h-10z" onclick="alert(3)"')
      + '<foreignObject><iframe src="x"/></foreignObject>';
    const out = rebuildMark(hostile)!;
    expect(out).not.toMatch(/script|onload|onclick|alert|iframe|foreignObject/i);
    /* A path whose outline is not an outline is dropped, not escaped. */
    expect(rebuildMark(MARK.replace('d="m0 0h10v10h-10z"', 'd="m0 0" /><script>x</script><path d="z"'))).not.toContain("script");
  });

  test("a file with no geometry is no mark", () => {
    expect(rebuildMark('<svg viewBox="0 0 1 1"></svg>')).toBeNull();
    expect(rebuildMark("<svg><path d=\"m0 0\"/></svg>")).toBeNull();
  });
});

describe("telling the app when the desktop switches theme", () => {
  const prior = { home: process.env.HOME, state: process.env.XDG_STATE_HOME };
  let home = "";
  let current = "";
  const stage = (slug: string, colors = COLORS) => {
    /* How the desktop switches: a new `theme` directory renamed over the old one. */
    const next = join(current, "theme-next");
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "colors.toml"), colors);
    rmSync(join(current, "theme"), { recursive: true, force: true });
    renameSync(next, join(current, "theme"));
    writeFileSync(join(current, "theme.name"), slug + "\n");
  };
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agx-desk-watch-"));
    current = join(home, ".local", "state", "omarchy", "current");
    mkdirSync(current, { recursive: true });
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
    __forgetDesktopPalette();
    stage("orbit-night");
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  afterAll(() => {
    if (prior.home === undefined) delete process.env.HOME; else process.env.HOME = prior.home;
    if (prior.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior.state;
    __forgetDesktopPalette();
  });

  /* Waits for the announcement rather than for a fixed 700 ms: the watcher
     thread is slow to hand an event over when the machine is busy (16 copies of
     this file at once missed the fixed window twice in ninety-six), and a late
     announcement is not a wrong one. "Once" is still exact: after the first one
     the file keeps listening for as long as a second would need to arrive. */
  const until = async (f: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; !f() && Date.now() < end;) await settle(20);
  };

  test("a switch is announced once, however many files it writes", async () => {
    let calls = 0;
    const stop = watchDesktopPalette(() => { calls++; });
    try {
      stage("orbit-day", COLORS.replace("#1a1b26", "#f5f0e6"));
      await until(() => calls > 0);
      await settle();
      expect(calls).toBe(1);
    } finally { stop(); }
  });

  /* Bun 1.3.9 ends an fs.watch at its first error event, and the error is a
     name that was in the directory when the event was queued and gone when the
     watcher looked at it: `theme-next` of every switch. A watcher that stayed
     dead after that announced nothing for the rest of the run, and in this file
     it was the whole flake: a switch staged straight after the watch opened,
     with the watcher thread a moment behind, was never announced (2 of 96 runs
     with sixteen copies of this file at once, none alone). The error is raised
     here on demand because on a quiet machine it comes about once in thirty. */
  const fakeWatch = () => {
    const opened: { fire: () => void; fail: () => void; closed: boolean }[] = [];
    const open = ((_dir: string, cb: () => void) => {
      let onError: () => void = () => {};
      const w = { closed: false, fire: () => cb(), fail: () => onError(), on: (_e: string, f: () => void) => { onError = f; }, close: () => { w.closed = true; } };
      opened.push(w);
      return w;
    }) as unknown as typeof import("node:fs").watch;
    return { open, opened };
  };

  test("a watch that raised an error is replaced, and the switch it missed is announced", async () => {
    let calls = 0;
    const { open, opened } = fakeWatch();
    const stop = watchDesktopPalette(() => { calls++; }, open);
    try {
      expect(opened.length).toBe(1);
      stage("orbit-day", COLORS.replace("#1a1b26", "#f5f0e6"));
      opened[0]!.fail();
      await until(() => calls > 0);
      expect(calls).toBe(1);
      expect(opened.length).toBe(2);
      expect(opened[0]!.closed).toBe(true);
      /* The new watch is the live one. */
      stage("orbit-dusk", COLORS.replace("#1a1b26", "#101018"));
      opened[1]!.fire();
      await until(() => calls > 1);
      expect(calls).toBe(2);
    } finally { stop(); }
    expect(opened[1]!.closed).toBe(true);
  });

  test("a directory that went away with the error ends the watch quietly", async () => {
    let calls = 0;
    const { open, opened } = fakeWatch();
    const stop = watchDesktopPalette(() => { calls++; }, (d, cb) => {
      if (opened.length > 0) throw new Error("ENOENT");
      return open(d, cb as never);
    });
    try {
      opened[0]!.fail();
      await settle(400);
      expect(calls).toBe(0);
    } finally { stop(); }
  });

  test("nothing is announced while nothing changes", async () => {
    let calls = 0;
    const stop = watchDesktopPalette(() => { calls++; });
    try {
      writeFileSync(join(current, "unrelated"), "x");
      await settle();
      expect(calls).toBe(0);
    } finally { stop(); }
  });

  test("a stopped watcher says nothing more", async () => {
    let calls = 0;
    const stop = watchDesktopPalette(() => { calls++; });
    stop();
    stage("orbit-day", COLORS.replace("#1a1b26", "#f5f0e6"));
    await settle();
    expect(calls).toBe(0);
  });

  test("a desktop that publishes nothing costs nothing: no watcher, no error", () => {
    rmSync(current, { recursive: true, force: true });
    const stop = watchDesktopPalette(() => {});
    expect(typeof stop).toBe("function");
    stop();
  });
});
