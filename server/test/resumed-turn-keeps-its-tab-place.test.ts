/*
 * A worker whose turn ended and is prompted again gets a new window (the old
 * one closed with the turn). That window used to land at the end of the bar by
 * its name's group, so the tab the person knew as "2" became "4" and the others
 * slid down one: they pressed 2 and landed on somebody else's tab.
 *
 * The resumed window takes the slot the old one had, and never selects itself.
 * Against a real tmux on a private socket with its own TMUX_TMPDIR.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { settled } from "./paneSettled.ts";
import { placeArgs, type PlaceWindow } from "../src/tmuxplace.ts";

const has = !!Bun.which("tmux");
const SOCK = `agx-slot-${process.pid}`;
let dir = "";
const before = { tmux: process.env.TMUX_TMPDIR, socket: process.env.AGENTGLASS_TMUX_SOCKET, inner: process.env.TMUX };
const sh = (...a: string[]) => spawnSync("tmux", ["-f", "/dev/null", "-L", SOCK, ...a], { stdio: "pipe", env: { ...process.env, TMUX_TMPDIR: dir } });
const names = () => sh("list-windows", "-t", "=work", "-F", "#{window_name}").stdout.toString().trim().split("\n");
const active = () => sh("list-windows", "-t", "=work", "-F", "#{window_active} #{window_name}").stdout.toString().split("\n").find((l) => l.startsWith("1 "))?.slice(2) ?? "";

beforeAll(() => {
  if (!has) return;
  dir = mkdtempSync(join(tmpdir(), "agx-slot-"));
  process.env.TMUX_TMPDIR = dir;
  process.env.AGENTGLASS_TMUX_SOCKET = SOCK;
  delete process.env.TMUX;
});
afterAll(() => {
  if (has) sh("kill-server");
  for (const [k, v] of [["TMUX_TMPDIR", before.tmux], ["AGENTGLASS_TMUX_SOCKET", before.socket], ["TMUX", before.inner]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/* The sandboxed builder cannot connect to a tmux socket: the live test then skips and the argv tests carry the claim. */
const live = has && (() => {
  const d = mkdtempSync(join(tmpdir(), "agx-probe-"));
  const env = { ...process.env, TMUX_TMPDIR: d };
  const r = spawnSync("tmux", ["-f", "/dev/null", "-L", `agx-probe-${process.pid}`, "new-session", "-d", "sleep", "5"], { stdio: "pipe", env });
  spawnSync("tmux", ["-L", `agx-probe-${process.pid}`, "kill-server"], { stdio: "pipe", env });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0;
})();

const W = (id: string, name: string, index: number): PlaceWindow => ({ id, name, index });
describe("where a resumed window goes (argv)", () => {
  const after = [W("@1", "lead-orbit", 0), W("@3", "lead-glass", 1), W("@4", "build-richtile", 2)];
  test("the old index is held by the tab that followed: go before it, not to the end of the name's group", () => {
    expect(placeArgs(after, "orbit-vr-512", "=work:", undefined, 1)).toEqual(["-b", "-t", "@3"]);
  });
  test("a free index is taken as it is; past the end is the end", () => {
    expect(placeArgs([W("@1", "a", 0), W("@4", "b", 2)], "x", "=work:", undefined, 1)).toEqual(["-t", "=work:1"]);
    expect(placeArgs(after, "orbit-vr-512", "=work:", undefined, 9)).toEqual(["-t", "=work:"]);
  });
  test("no slot keeps the old group placement", () => {
    expect(placeArgs(after, "lead-new", "=work:")).toEqual(["-a", "-t", "@3"]);
  });
});

describe.skipIf(!live)("a resumed turn keeps its tab's place", () => {
  test("the 2nd of 4 comes back as the 2nd, and the window on screen does not change", async () => {
    const { engineWindowOutcome } = await import("../src/tmuxpane.ts");
    const order = ["lead-orbit", "orbit-vr-512", "lead-glass", "build-richtile"];
    expect(sh("new-session", "-d", "-s", "work", "-n", order[0]!, "-c", "/tmp", "sleep", "300").status).toBe(0);
    sh("set-option", "-g", "renumber-windows", "on");
    for (const n of order.slice(1)) expect(sh("new-window", "-d", "-t", "=work:", "-n", n, "-c", "/tmp", "sleep", "300").status).toBe(0);
    expect(await settled(names, (v) => v.length === 4)).toEqual(order);
    sh("select-window", "-t", "=work:lead-glass");

    /* The turn ends: its window closes, the rest close ranks. */
    sh("kill-window", "-t", "=work:orbit-vr-512");
    expect(names()).toEqual(["lead-orbit", "lead-glass", "build-richtile"]);

    const r = await engineWindowOutcome("/tmp", "orbit-vr-512", ["sleep", "300"], "/tmp", { AGENTGLASS_TOKEN: "t" }, "work", false, false, false, "", 1);
    expect(r.ok).toBe(true);
    expect(await settled(names, (v) => v.length === 4)).toEqual(order);
    expect(active(), "no focus change").toBe("lead-glass");
  });
});
