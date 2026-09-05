/*
 * The engine's prefix, when its server came up without our config.
 *
 * Reported with two screenshots: the tab strip's chip reading `C-b ENGINE`
 * while Settings ▸ Pane engine had `C-f` saved and applied — "sometimes it
 * switches to ctrl b on its own when I have it preset".
 *
 * The chip was telling the truth. `-f <conf>` is only read when the command
 * STARTS the tmux server; everything that reaches a server already running
 * inherits whatever the first command set up. An engine server born some other
 * way is therefore on tmux's own defaults — `C-b` — and stays there, because
 * `source-file` only runs when the settings are SAVED, and nobody saves a
 * setting that already says what they want.
 *
 * So the prefix is checked against the setting on every attach and the config
 * is put back when they disagree. Against a real tmux, because the whole claim
 * is about what a real server does with `-f`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healPrefix, prefixKeys, __resetHeal, type TmuxTarget } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const SOCK = [...TMUX_ISOLATED, "-L", "agx-prefix-heal"];
const tmux = (...a: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...a], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const dir = mkdtempSync(join(tmpdir(), "agx-prefix-heal-"));
const conf = join(dir, "tmux.conf");
writeFileSync(conf, "unbind C-b\nset -g prefix C-f\nbind C-f send-prefix\n");

afterAll(() => { tmux("kill-server"); });

describe("an engine server that never read the config", () => {
  test("comes up on tmux's own prefix, which is the bug as the user sees it", () => {
    tmux("kill-server");
    // Born WITHOUT `-f`: this is the shape every path that is not the engine's
    // own attach produces, and the reason `-f` on the attach cannot save it.
    tmux("new-session", "-d", "-s", "desk");
    expect(prefixKeys({ socket: SOCK } as TmuxTarget)).toEqual(["C-b"]);
  });

  test("the config is put back, and the prefix with it", () => {
    __resetHeal();
    const t = { socket: SOCK } as TmuxTarget;
    expect(healPrefix(t, "C-f", conf)).toEqual(["C-f"]);
    // Not just what the function returned — what tmux now says.
    expect(tmux("show-options", "-gqv", "prefix")).toBe("C-f");
  });

  test("a server that already agrees is left alone", () => {
    __resetHeal();
    // null, not `["C-f"]`: the caller keeps what it read, and nothing is sent
    // to a server that is already right. This runs on every attach.
    expect(healPrefix({ socket: SOCK } as TmuxTarget, "C-f", conf)).toBe(null);
  });

  test("and a config that cannot take is not re-sourced on every attach", () => {
    /* Throttled per socket: a conf tmux refuses would otherwise turn every
       attach into a failed re-source for as long as the session lives. */
    __resetHeal();
    const t = { socket: SOCK } as TmuxTarget;
    const empty = join(dir, "empty.conf");
    writeFileSync(empty, "# nothing that moves the prefix\n");
    expect(healPrefix(t, "M-x", empty)).toEqual(["C-f"]);  // tried, did not take
    expect(healPrefix(t, "M-x", empty)).toBe(null);        // and does not try again
  });
});

/*
 * And it has to be checked while you are sitting there.
 *
 * The correction used to run when a client ATTACHED, which is a moment that
 * does not come round: a desk stays attached for hours. So an engine that
 * drifted at noon was still wrong at five — reported twice, the second time
 * with the conf on disk saying `C-f`, the settings panel saying `C-f`, and the
 * live server saying `C-b`.
 *
 * The sweep already reads the prefix every tick; the comparison is a string,
 * and the write behind it is throttled per socket.
 */
describe("where the check lives", () => {
  test("in the sweep, beside the read it compares against", async () => {
    const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    const sweep = src.slice(src.indexOf("if (frame) session.tmuxPrefix = frame.prefix;"));
    expect(sweep.slice(0, 2000)).toContain("healPrefix(session.tmux, tmuxPrefix() || \"C-b\", ensureConf())");
  });

  test("and not only where a client arrives", () => {
    // `followSession` runs on attach and on `prefix s`; neither is a clock.
    return Bun.file(new URL("../src/terminal.ts", import.meta.url)).text().then((src) => {
      const follow = src.slice(src.indexOf("const followSession ="), src.indexOf("Watch for tmux coming and going"));
      expect(follow).not.toContain("healPrefix");
    });
  });
});
