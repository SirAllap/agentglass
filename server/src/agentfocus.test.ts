import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeMoveArgs } from "./agentops.ts";
import { parsePlaceWindows, PLACE_FORMAT } from "./tmuxplace.ts";
import { settled } from "../test/paneSettled.ts";

let n = 0;
/** One private tmux server per test: own socket, own TMUX_TMPDIR, never reused after kill-server. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agxf-"));
  const env = { ...process.env, TMUX_TMPDIR: dir } as Record<string, string>;
  delete env.TMUX;
  const sock = `agx-focus-${process.pid}-${++n}`;
  const tm = (...a: string[]) => spawnSync("tmux", ["-L", sock, "-f", "/dev/null", ...a], { env, encoding: "utf8" });
  const active = (s: string) => tm("display-message", "-p", "-t", `=${s}:`, "#{window_id}").stdout.trim();
  const up = async (s: string) => { tm("new-session", "-d", "-s", s, "sleep", "60"); await settled(() => active(s), (v) => v !== ""); };
  const done = () => { tm("kill-server"); rmSync(dir, { recursive: true, force: true }); };
  return { tm, active, up, done };
}
const have = spawnSync("tmux", ["-V"]).status === 0 && (() => { const r = rig(); const ok = r.tm("new-session", "-d", "-s", "probe").status === 0; r.done(); return ok; })();
const t = have ? test : test.skip;

t("moving a tab with the agent path's args leaves every session's active window alone", async () => {
  const r = rig();
  try {
    await r.up("acme"); await r.up("scratch");
    r.tm("new-window", "-d", "-t", "=acme:", "sleep", "60");
    const mover = r.tm("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=scratch:", "sleep", "60").stdout.trim();
    const before = { acme: r.active("acme"), scratch: r.active("scratch") };
    expect(before.acme).not.toBe("");
    const listed = r.tm("list-windows", "-t", "=acme:", "-F", PLACE_FORMAT).stdout;
    const args = placeMoveArgs(mover, "acme", parsePlaceWindows(listed), "builder-x");
    expect(args).toContain("-d");
    expect(r.tm(...args).status).toBe(0);
    expect(r.tm("list-windows", "-t", "=acme:", "-F", "#{window_id}").stdout).toContain(mover);
    expect({ acme: r.active("acme"), scratch: r.active("scratch") }).toEqual(before);
  } finally { r.done(); }
});

t("a new-window with -d leaves the active window alone; without it, it moves", async () => {
  const r = rig();
  try {
    await r.up("acme");
    const was = r.active("acme");
    expect(was).not.toBe("");
    r.tm("new-window", "-d", "-t", "=acme:", "sleep", "60");
    expect(r.active("acme")).toBe(was);
    r.tm("new-window", "-t", "=acme:", "sleep", "60");
    expect(r.active("acme")).not.toBe(was);
  } finally { r.done(); }
});

test("the engine's await-command window is opened with -d unless a person asked", () => {
  const src = readFileSync(new URL("./tmuxlayout.ts", import.meta.url), "utf8");
  expect(src).toContain('["new-window", ...(select ? [] : ["-d"]), "-P"');
});
