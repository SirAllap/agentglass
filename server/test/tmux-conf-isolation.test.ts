/*
 * One engine's config must not be written over another's.
 *
 * The generated tmux.conf is a materialisation of config.json — which lives
 * under XDG_CONFIG_HOME — but it was written to the STATE dir, which follows
 * XDG_STATE_HOME. Redirect one and not the other, as every harness in this repo
 * did, and a throwaway instance rewrites the conf the real engine runs on.
 * Nothing warns: the file is ours, so `ensureConf` just writes it.
 *
 * Measured on a real machine, twice in one afternoon. A probe with an isolated
 * config (and therefore no prefix set) rewrote the shared `tmux.conf` with
 * `set -g prefix C-b`, and the desk's engine — up since 08:42 and never
 * restarted — came back reporting C-b, because the settings panel's Save and
 * the prefix heal both `source-file` that path into the live server. Reported
 * as "tmux has changed by itself again… settings show ctrl + f and the console
 * shows ctrl + b".
 *
 * The default install keeps the plain name — an installed app must not orphan
 * the file its running server was started with.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { confPath } from "../src/tmuxconf.ts";

const HOME = process.env.HOME;
const CFG = process.env.XDG_CONFIG_HOME;
const STATE = process.env.AGENTGLASS_STATE_DIR;

afterEach(() => {
  if (HOME === undefined) delete process.env.HOME; else process.env.HOME = HOME;
  if (CFG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = CFG;
  if (STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = STATE;
});

describe("the generated conf is named after the settings it came from", () => {
  test("the ordinary install keeps the plain name", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(basename(confPath())).toBe("tmux.conf");
  });

  test("a redirected config dir gets a file of its own", () => {
    process.env.XDG_CONFIG_HOME = join(mkdtempSync(join(tmpdir(), "agx-conf-")), "config");
    const name = basename(confPath());
    expect(name).not.toBe("tmux.conf");
    expect(name).toMatch(/^tmux-[0-9a-f]{8}\.conf$/);
  });

  test("and keeps the same one across restarts", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "agx-conf-")), "config");
    process.env.XDG_CONFIG_HOME = dir;
    const first = confPath();
    process.env.XDG_CONFIG_HOME = dir;
    expect(confPath()).toBe(first);
  });

  test("two isolated instances do not collide", () => {
    process.env.XDG_CONFIG_HOME = join(mkdtempSync(join(tmpdir(), "agx-conf-a-")), "config");
    const a = confPath();
    process.env.XDG_CONFIG_HOME = join(mkdtempSync(join(tmpdir(), "agx-conf-b-")), "config");
    expect(confPath()).not.toBe(a);
  });
});

describe("the harnesses that boot a real server", () => {
  test("every one of them isolates the state dir, not just the config", async () => {
    /* This is the rule that was missing, and it is cheaper to hold here than to
       find again from a desk report. A script that redirects XDG_CONFIG_HOME
       and boots server/src/index.ts must redirect the state dir too. */
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = join(import.meta.dir, "..", "..", "scripts");
    const bad: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(dir, f), "utf8");
      if (!/XDG_CONFIG_HOME/.test(text)) continue;
      if (!/server[/"'`,\s]*.{0,12}index\.ts/.test(text) && !/index\.ts/.test(text)) continue;
      if (!/AGENTGLASS_STATE_DIR/.test(text)) bad.push(f);
    }
    expect(bad, "redirect AGENTGLASS_STATE_DIR too — the engine's tmux.conf lives there").toEqual([]);
  });
});
