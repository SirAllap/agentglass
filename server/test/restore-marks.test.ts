/*
 * A RESTORED DESK SAYS SO, AND SAYING SO CHANGES NOTHING.
 *
 * After a reboot the restore hands back plain shells; the strip marks those
 * windows (`restored`, and `was`/`resume` for the ones that ran an agent) so
 * a person is told nothing is running and can resume on purpose. The owner's
 * rule is that the restore itself stays exact, so the first case compares the
 * restored windows (names, order, splits) with what was photographed, and the
 * marks are asserted beside it. The pure marking, the dismissal and the
 * in-place resume follow. Driven on a real tmux on its own socket.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { story } from "./story.ts";

const SOCKET = `agx-rmarks-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-rmarks-tmp-${process.pid}`);
const STATE = join(tmpdir(), `agx-rmarks-state-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = STATE;
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "300";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let marks: typeof import("../src/tmuxrestored.ts");
let pane: typeof import("../src/tmuxpane.ts");
const have = !!Bun.which("tmux");
const S = `agxrmarks${process.pid}`;

const killAndWait = async () => {
  await pane.tmux(["kill-server"]).catch(() => null);
  for (let i = 0; i < 100; i++) {
    const r = await pane.tmux(["list-sessions"]).catch(() => ({ ok: false }));
    if (!r.ok) return;
    await Bun.sleep(50);
  }
};
/** Names, order and split shape of every window: what a restore must keep. */
const desk = async () => {
  const r = await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_index}|#{window_name}|#{window_panes}|#{pane_current_path}"]);
  return r.stdout.trim();
};
/** A layout without its sizes: `{` side by side, `[` stacked. */
const shape = (layout: string): string => {
  if (layout.startsWith("{")) {
    const walk = (n: { t: string; c?: unknown[] }): string =>
      n.t === "p" ? "P" : `P${n.t === "h" ? "{" : "["}${(n.c ?? []).map((k) => walk(k as typeof n)).join(",")}${n.t === "h" ? "}" : "]"}`;
    return walk(JSON.parse(layout).L);
  }
  return layout.replace(/[0-9a-f]{4},/, "").replace(/\d+x\d+,\d+,\d+(,\d+)?/g, "P");
};
const layouts = async () => (await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_layout}"])).stdout.trim().split("\n").map(shape);
const ids = async () => (await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_id}"])).stdout.trim().split("\n");

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  marks = await import("../src/tmuxrestored.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMPDIR }, stdout: "ignore", stderr: "ignore" });
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  rmSync(TMPDIR, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
});

describe("the marking, on its own", () => {
  const win = (panes: object[]) => ({ id: "@1", index: 0, name: "w", active: true, flags: "", panes }) as never;
  const sh = { id: "%1", index: 0, active: true, command: "bash", path: "/tmp", startCommand: "" };

  test("a shell is marked restored with nothing to resume; an agent pane carries its name and conversation", () => {
    const m = marks.restoredMarks([
      { id: "@5", window: win([sh]) },
      { id: "@6", window: win([sh, { ...sh, id: "%2", index: 1, agentSession: "0f1e2d3c-1111-2222-3333-444455556666" }]) },
    ], "lazy");
    expect(m["@5"]).toEqual({});
    expect(m["@6"]?.was).toBe("Claude Code");
    expect(m["@6"]?.resume).toBe("0f1e2d3c-1111-2222-3333-444455556666");
    expect(m["@6"]?.paneIndex).toBe(1);
  });

  test("in `all` mode the restore started the agents itself, so nothing says it was running", () => {
    const m = marks.restoredMarks([{ id: "@6", window: win([{ ...sh, agentSession: "0f1e2d3c-1111-2222-3333-444455556666" }]) }], "all");
    expect(m["@6"]).toEqual({});
  });

  test("a window that was never made (empty id) is not marked", () => {
    expect(marks.restoredMarks([{ id: "", window: win([sh]) }], "lazy")).toEqual({});
  });
});

describe.skipIf(!have)("after a restore", () => {
  const step = story();
  let before = "";
  let beforeLayouts: string[] = [];

  step("the restored desk is exactly the photographed one, and every window is marked", async () => {
    restore.__resetRestoreState();
    marks.__forgetRestoredCache();
    expect((await pane.tmux(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "-n", "alpha", "-c", "/tmp", "sleep 60"])).ok).toBe(true);
    await pane.tmux(["split-window", "-h", "-d", "-t", `${S}:0`, "-c", "/tmp", "sleep 60"]);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "beta", "-c", "/tmp", "sleep 60"]);
    await pane.tmux(["set-window-option", "-t", `${S}:0`, "automatic-rename", "off"]);
    await pane.tmux(["set-window-option", "-t", `${S}:1`, "automatic-rename", "off"]);
    before = await desk();
    beforeLayouts = await layouts();
    await restore.captureLayout();
    await killAndWait();

    expect((await restore.restoreLayout("lazy")).ok).toBe(true);
    expect(await desk(), "names, order, pane counts and folders").toBe(before);
    expect(await layouts(), "the splits").toEqual(beforeLayouts);
    expect(beforeLayouts).toEqual(["P{P,P}", "P"]);
    const now = await ids();
    for (const id of now) {
      const f = marks.restoredFields(id);
      expect(f, id).not.toBeNull();
      expect(f?.restored).toBe(true);
      expect(f?.restoredAt).toBeGreaterThan(0);
      expect(f?.was, "plain shells were not running an agent").toBeUndefined();
    }
  });

  step("the record survives the server restarting, and a record for another tmux server is dropped", async () => {
    marks.__forgetRestoredCache();
    const id = (await ids())[0]!;
    expect(marks.restoredFields(id), "read back from the file").not.toBeNull();
    marks.dropStaleMarks("0.0-another-server");
    expect(marks.restoredFields(id)).toBeNull();
  });

  step("a pass that built nothing leaves the banner alone, and dismissing takes only what was dismissed", async () => {
    marks.noteRestored([{ id: "@1", window: { panes: [] } as never }, { id: "@2", window: { panes: [] } as never }], "lazy", "9.9");
    marks.noteRestored([], "lazy", "9.9");
    expect(marks.restoredIds().sort()).toEqual(["@1", "@2"]);
    marks.dismissRestored(["@1"]);
    expect(marks.restoredIds()).toEqual(["@2"]);
    marks.dismissRestored();
    expect(marks.restoredIds()).toEqual([]);
    expect(JSON.parse(readFileSync(join(STATE, "tmux", "restore", "restored.json"), "utf8")).windows).toEqual({});
  });

  step("Resume replays the saved argv in the same pane: the window keeps its name and place, and the mark goes", async () => {
    await killAndWait();
    expect((await pane.tmux(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "-n", "alpha", "-c", "/tmp", "sleep 60"])).ok).toBe(true);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "beta", "-c", "/tmp", "sleep 60"]);
    const [a = "", b = ""] = await ids();
    mkdirSync(join(STATE, "tmux", "restore"), { recursive: true });
    const pane0 = { id: "%0", index: 0, active: true, command: "sh", path: "/tmp", startCommand: "", startArgv: ["sleep", "67"] };
    writeFileSync(join(STATE, "tmux", "restore", "restored.json"), JSON.stringify({
      engine: "", at: Date.now(), windows: { [b]: { was: "Claude Code", pane: pane0, paneIndex: 0 }, [a]: {} },
    }));
    marks.__forgetRestoredCache();
    expect(await restore.resumeRestored("@999"), "a window nobody marked").toBe(false);
    expect(await restore.resumeRestored(a), "a marked shell has nothing to resume").toBe(false);
    expect(await restore.resumeRestored(b)).toBe(true);
    const cmds = (await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_name}|#{pane_start_command}"])).stdout.trim().split("\n");
    expect(cmds[0]).toStartWith("alpha|");
    expect(cmds[1], "same window, same name, the replayed command").toContain("beta|");
    expect(cmds[1]).toContain("67");
    expect(marks.restoredIds(), "resumed window is no longer marked").toEqual([a]);
  });
});
