/*
 * A dead window in the engine session is closed by the bench and the panel
 * only when this app opened it as that window (the `@agx-panel` stamp), never
 * for carrying the name: a person's kept dead pane renamed `bench-3` is theirs.
 *
 * The two closers (`ensurePanelWindow`, `benchLive`) and the one stamp write
 * are driven against a fake tmux binary that logs its calls: no socket, no
 * server, nothing of the developer's reachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetTmuxBinCache } from "../src/tmuxbin.ts";
import { __resetTmuxConfState, confPath } from "../src/tmuxconf.ts";
import { __resetHeal, __resetSlowTmux } from "../src/tmuxctl.ts";
import { __resetPaneState, closablePanelCorpse } from "../src/tmuxpane.ts";

describe("closablePanelCorpse", () => {
  test("a dead window this app opened as that name is closed", () => {
    expect(closablePanelCorpse({ dead: true, panel: "bench-3" }, "bench-3")).toBe(true);
  });
  test("a person's dead pane renamed to that name is not", () => {
    expect(closablePanelCorpse({ dead: true, panel: "" }, "bench-3")).toBe(false);
    expect(closablePanelCorpse({ dead: true, panel: "bench-30" }, "bench-3")).toBe(false);
  });
  test("a live window is never closed here", () => {
    expect(closablePanelCorpse({ dead: false, panel: "bench-3" }, "bench-3")).toBe(false);
  });
});

const KEYS = ["AGENTGLASS_TMUX_PATH", "AGENTGLASS_STATE_DIR", "AGENTGLASS_ROOT", "AGENTGLASS_TMUX_SOCKET", "TMUX_TMPDIR", "TMUX", "FAKE_TMUX_LOG", "FAKE_TMUX_PANES"] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let box = "";
const log = () => readFileSync(join(box, "log"), "utf8").split("\n").filter(Boolean);
const kills = () => log().filter((l) => / kill-window /.test(l)).map((l) => l.split(" kill-window -t ")[1]);
/** One row per pane: id, name, dead, stamp — what the list-panes format asks for. */
const panes = (rows: string[][]) => {
  writeFileSync(join(box, "panes"), rows.map((r) => r.join("\t")).join("\n") + "\n");
  writeFileSync(join(box, "log"), "");
  /* No conf on disk: `confHealth` then has nothing to validate. A conf there is
     checked once with a real tmux server, which this fake is not. The path is
     asked, not spelled: an XDG_CONFIG_HOME an earlier file left set renames the
     conf to `tmux-<hash>.conf`, and deleting `tmux.conf` then left it in place. */
  rmSync(confPath(), { force: true });
};

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), "agx-stamp-"));
  mkdirSync(join(box, "state"), { recursive: true });
  mkdirSync(join(box, "orbit"), { recursive: true });
  const bin = join(box, "tmux");
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "$FAKE_TMUX_LOG"
for a in "$@"; do case "$a" in
  -V) echo "tmux 3.5a"; exit 0;;
  list-panes) cat "$FAKE_TMUX_PANES"; exit 0;;
  new-window) echo "@9"; exit 0;;
esac; done
exit 0
`);
  chmodSync(bin, 0o755);
  Object.assign(process.env, {
    AGENTGLASS_TMUX_PATH: bin, AGENTGLASS_STATE_DIR: join(box, "state"), AGENTGLASS_ROOT: box,
    AGENTGLASS_TMUX_SOCKET: `agx-stamp-${process.pid}`, TMUX_TMPDIR: box,
    FAKE_TMUX_LOG: join(box, "log"), FAKE_TMUX_PANES: join(box, "panes"),
  });
  delete process.env.TMUX;
});
/* Module state another file in the same `bun test` process may have left:
   the conf check, the tmux binary cache, the slow-tmux cooldown, the heal
   stamps and the pane pins. Each test starts from none of it. */
beforeEach(() => {
  __resetTmuxConfState();
  __resetTmuxBinCache();
  __resetSlowTmux();
  __resetHeal();
  __resetPaneState();
});
afterAll(() => {
  for (const k of KEYS) { const v = SAVED[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (box) rmSync(box, { recursive: true, force: true });
});

describe("the stamp, written and read", () => {
  test("a panel window this app opens is stamped with its name", async () => {
    const pane = await import("../src/tmuxpane.ts");
    panes([]);
    expect(pane.ensurePanelWindow(join(box, "orbit"), pane.benchWindowName(3), { runs: ["sh", "-c", "sleep 1"] })?.windowId).toBe("@9");
    expect(log().some((l) => / set-option -w -t @9 @agx-panel bench-3$/.test(l))).toBe(true);
  });

  test("opening a panel closes its own stamped corpse, and not a person's dead pane of that name", async () => {
    const pane = await import("../src/tmuxpane.ts");
    panes([["@1", "bench-3", "1", "bench-3"], ["@2", "bench-3", "1", ""]]);
    pane.ensurePanelWindow(join(box, "orbit"), pane.benchWindowName(3), { runs: ["sh", "-c", "sleep 1"] });
    expect(kills()).toEqual(["@1"]);
  });

  test("the bench closes its own stamped corpse, and not a person's dead pane of a bench name", async () => {
    const bench = await import("../src/bench.ts");
    panes([["@1", "bench-3", "1", "bench-3"], ["@2", "bench-4", "1", ""], ["@3", "bench-5", "0", ""]]);
    expect((await bench.benchLive(join(box, "orbit"))).slots).toEqual([5]);
    expect(kills()).toEqual(["@1"]);
  });
});
