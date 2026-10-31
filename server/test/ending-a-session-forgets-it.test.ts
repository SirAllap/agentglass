/**
 * A session somebody ended must not come back at the next start.
 *
 * `layout.json` was taught not to lose a session — right for one that merely is
 * not running, wrong for one just ended on purpose. Reported the moment the
 * picker shipped: "I just deleted these two… I restarted the app and they show
 * up again. You are not handling that when sessions are deleted they also get
 * removed from that automatic restart."
 *
 * Against a real tmux on its own socket, `-f /dev/null` so none of the
 * developer's own configuration comes along and starts restoring their sessions
 * inside the test.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const SOCK = `agx-forget-${process.pid}`;
const STATE = mkdtempSync(join(tmpdir(), "agx-forget-"));
const sock = ["-f", "/dev/null", "-L", SOCK];
const sh = (a: string[]) => Bun.spawnSync(["tmux", ...sock, ...a], { stdout: "pipe", stderr: "pipe" });
const live = () => sh(["list-sessions", "-F", "#{session_name}"]).stdout.toString().trim().split("\n").filter(Boolean).sort();

let ctl: typeof import("../src/tmuxctl.ts");
let restore: typeof import("../src/tmuxrestore.ts");

const layout = (): string[] => {
  const p = join(STATE, "tmux", "restore", "layout.json");
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")).sessions ?? []).map((s: { name: string }) => s.name).sort();
};

beforeAll(async () => {
  process.env.AGENTGLASS_TMUX_SOCKET = SOCK;
  process.env.AGENTGLASS_STATE_DIR = STATE;
  ctl = await import("../src/tmuxctl.ts");
  restore = await import("../src/tmuxrestore.ts");
  for (const n of ["keepme", "endme", "alsoend"]) sh(["new-session", "-d", "-s", n, "-c", "/tmp"]);
  await restore.captureLayout();
});

afterAll(() => {
  sh(["kill-server"]);
  try { rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCK), { force: true }); } catch { /* gone */ }
  try { rmSync(STATE, { recursive: true, force: true }); } catch { /* gone */ }
});

const step = story();

step("all three are remembered to start with", () => {
  expect(layout()).toEqual(["alsoend", "endme", "keepme"]);
});

step("ending one takes it out of the restore state", async () => {
  expect(ctl.killSessionByName(sock, "endme", "keepme")).toBe(true);
  restore.forgetSession("endme");
  expect(live(), "the session itself is gone").toEqual(["alsoend", "keepme"]);
  expect(layout(), "AND IT COMES BACK AT THE NEXT START without this").toEqual(["alsoend", "keepme"]);
});

step("and a capture running a moment later cannot put it back", async () => {
  /* The race this would otherwise have: the sweep captures every two seconds,
     and a session merely absent is deliberately KEPT by the merge. */
  await restore.captureLayout();
  expect(layout()).toEqual(["alsoend", "keepme"]);
});

step("a session that is merely not running is still kept", async () => {
  /* The whole point of the file, and what must not be broken by the above. */
  ctl.killSessionByName(sock, "alsoend", "keepme");   // ended, but NOT forgotten
  await restore.captureLayout();
  expect(layout(), "an unplanned disappearance is not a decision").toEqual(["alsoend", "keepme"]);
});

/*
 * THE OTHER WAY BACK: THE TERMINAL'S OWN ATTACH.
 *
 * With the restore file clean, an ended worktree session still returned at
 * every start, empty and with the panel on it: a plain terminal on the engine
 * opens `new-session -A -s <checkout>`, and `-A` creates what is not there.
 * The decision is read from disk, so it holds for a process that never saw
 * the end — which is what a restart is.
 */
const sessionIn = (argv: string[] | null): string => argv![argv!.lastIndexOf("-s") + 1]!;

step("a restarted terminal does not make an ended session again", async () => {
  const { plainEngineArgv } = await import("../src/terminal.ts");
  expect(live()).not.toContain("endme");
  expect(sessionIn(plainEngineArgv("/home/me/code/endme")), "the ended name must not be created").not.toBe("endme");
  expect(sessionIn(plainEngineArgv("/home/me/code/endme")), "it lands where the person was").toBe("keepme");
});

step("a session that went without being ended still opens by its own name", async () => {
  /* `alsoend` went without `forgetSession` — a crash, as far as anyone knows. */
  const { plainEngineArgv } = await import("../src/terminal.ts");
  expect(sessionIn(plainEngineArgv("/home/me/code/alsoend"))).toBe("alsoend");
  expect(sessionIn(plainEngineArgv("/home/me/code/keepme"))).toBe("keepme");
});
