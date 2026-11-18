/*
 * A worker whose role prompt or card text is tens of KB still opens a window.
 *
 * tmux refuses `new-window` outright, with no window at all, once the
 * command's arguments cross roughly 15-20 KB (measured on tmux 3.8). A role's
 * brief and a card's text are inlined into a headless engine's own argv
 * (agents/headless.ts), never through `handedOver` (agentticket.ts) — that
 * one only ever sees a caller's own `--prompt`, always the last element of
 * what it builds. Here the big element is not always last (an engine's own
 * flags can come after it, as hermes's `--run-budget` does), so the fix in
 * `startAgent` (agentops.ts) finds whichever argv element is actually the
 * big one and spills THAT one, wherever it sits, into the window's own
 * scratch directory.
 *
 * Against a real tmux on a socket of its own, for the same reason every
 * other suite under this name is: a size tmux itself enforces is not safe to
 * fake.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { settled } from "./paneSettled.ts";

const SOCKET = `agx-longcmd-${process.pid}`;
const SAVED = { sock: process.env.AGENTGLASS_TMUX_SOCKET, tmp: process.env.TMUX_TMPDIR };
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const AO = await import("../src/agentops.ts");
const { tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const { wrappedTui, prepareRun } = await import("../src/agents/headless.ts");

const have = tmuxCapability().available;
let dir = "";

afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["AGENTGLASS_TMUX_SOCKET", SAVED.sock], ["TMUX_TMPDIR", SAVED.tmp]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("a worker argv tmux would otherwise refuse", () => {
  it("still opens a window when the big argument is last, the common shape", async () => {
    if (!have) return;
    dir = mkdtempSync(join(tmpdir(), "agx-longcmd-"));
    const name = "w-longcmd-last";
    const prompt = "brief: ".padEnd(30_000, "x");
    const seen = join(dir, "seen-last.txt");
    // A stand-in CLI that writes its SECOND-TO-LAST argument (the prompt, as
    // claude takes it) to the path its own LAST argument names.
    const cli = join(dir, "stub-last.sh");
    writeFileSync(cli, '#!/bin/sh\nn=$#\ni=0\nfor a; do i=$((i+1)); [ "$i" = "$((n-1))" ] && val=$a; [ "$i" = "$n" ] && out=$a; done\nprintf %s "$val" > "$out"\n', { mode: 0o755 });
    chmodSync(cli, 0o755);
    // `runFiles` only names the paths; `prepareRun` is what makes the
    // directory the wrapper writes `err`/`rc` into (every real caller goes
    // through this first).
    const files = prepareRun(name, prompt, "none");
    const argv = wrappedTui(files, [cli, "--role", "builder", prompt, seen]);
    const r = await AO.startAgent({
      root: dir, name, cwd: dir, kind: "claude", exactArgv: argv, keep: true,
      lockedRole: true, yoloAllowed: false,
      owner: { seatRoot: dir, model: "m", startedBy: null, resumeId: null },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    await settled(() => existsSync(seen), (v) => v);
    expect(readFileSync(seen, "utf8")).toBe(prompt);
  });

  it("still opens a window when the big argument sits in the middle, as a role's engine flags can leave it", async () => {
    if (!have) return;
    dir = mkdtempSync(join(tmpdir(), "agx-longcmd-"));
    const name = "w-longcmd-mid";
    const card = "card: ".padEnd(40_000, "y");
    const seen = join(dir, "seen-mid.txt");
    const cli = join(dir, "stub-mid.sh");
    // Writes its SECOND-TO-LAST argument (the card text), not its last one
    // (`--run-budget 60`, matching hermes's own shape), to prove the spill
    // put the text back exactly where it was, not merely at the end.
    writeFileSync(cli, '#!/bin/sh\nn=$#\ni=0\nfor a; do i=$((i+1)); if [ "$i" = "$((n-2))" ]; then mid=$a; fi; done\nprintf %s "$mid" > "'
      + seen + '"\n', { mode: 0o755 });
    chmodSync(cli, 0o755);
    const files = prepareRun(name, card, "none");
    const argv = wrappedTui(files, [cli, "chat", "--query", card, "--run-budget", "60"]);
    const r = await AO.startAgent({
      root: dir, name, cwd: dir, kind: "claude", exactArgv: argv, keep: true,
      lockedRole: true, yoloAllowed: false,
      owner: { seatRoot: dir, model: "m", startedBy: null, resumeId: null },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    await settled(() => existsSync(seen), (v) => v);
    expect(readFileSync(seen, "utf8")).toBe(card);
  });

  it("leaves a short command alone", async () => {
    if (!have) return;
    dir = mkdtempSync(join(tmpdir(), "agx-longcmd-"));
    const name = "w-longcmd-short";
    const files = prepareRun(name, "go", "none");
    const argv = wrappedTui(files, ["sleep", "30"]);
    const r = await AO.startAgent({
      root: dir, name, cwd: dir, kind: "claude", exactArgv: argv, keep: true,
      lockedRole: true, yoloAllowed: false,
      owner: { seatRoot: dir, model: "m", startedBy: null, resumeId: null },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) await settled(() => AO.screenOf(r.agent.paneId), (s) => !!s && s.length > 0);
  });
});
