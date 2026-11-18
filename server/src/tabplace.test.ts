import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastOfProject, placeMoveArgs } from "./agentops.ts";
import { parsePlaceWindows, PLACE_FORMAT } from "./tmuxplace.ts";
import { settled } from "../test/paneSettled.ts";

test("place puts a window after its project's last tab and renumbers to 1,2,3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agxp-"));
  const env = { ...process.env, TMUX_TMPDIR: dir } as Record<string, string>;
  delete env.TMUX;
  const sock = `agx-place-${process.pid}`;
  const tm = (...a: string[]) => spawnSync("tmux", ["-L", sock, "-f", "/dev/null", ...a], { env, encoding: "utf8" });
  try {
    tm("new-session", "-d", "-s", "orbit", "-n", "orbit-orch", "-c", "/tmp", "sleep", "60");
    await settled(() => tm("list-windows", "-t", "=orbit:", "-F", "#{window_id}").stdout, (v) => v.trim() !== "");
    const mk = (n: string, cwd: string) => tm("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=orbit:", "-n", n, "-c", cwd, "sleep", "60").stdout.trim();
    const w1 = mk("acme-orch", "/var"), other = mk("orbit-x", "/tmp"), mine = mk("worker-q", "/usr");
    const rows = () => settled(() => tm("list-windows", "-t", "=orbit:", "-F", "#{window_id}\t#{window_index}\t#{pane_current_path}").stdout.split("\n").filter(Boolean).map((l) => l.split("\t")).map((c) => ({ id: c[0]!, index: Number(c[1]), path: c[2]! })), (r) => r.every((x) => x.path !== "" && x.path !== process.cwd()));
    const got = await rows();
    const resolve = (d: string) => (d === "/var" || d === "/usr" ? "/acme" : "/orbit");
    const after = lastOfProject(got, "/acme", mine, resolve);
    expect(after).toBe(w1);
    const args = placeMoveArgs(mine, "orbit", parsePlaceWindows(tm("list-windows", "-t", "=orbit:", "-F", PLACE_FORMAT).stdout), "worker-q", after);
    expect(args).toContain("-d");
    expect(tm(...args).status).toBe(0);
    tm("move-window", "-r", "-t", "=orbit:");
    const out = tm("list-windows", "-t", "=orbit:", "-F", "#{window_index}:#{window_id}").stdout.trim().split("\n");
    expect(out.map((l) => l.split(":")[0])).toEqual(["0", "1", "2", "3"]);
    expect(out.map((l) => l.split(":")[1])).toEqual([out[0]!.split(":")[1], w1, mine, other]);
  } finally { tm("kill-server"); rmSync(dir, { recursive: true, force: true }); }
});
