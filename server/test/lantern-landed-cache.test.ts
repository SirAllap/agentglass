/*
 * THE "IS THIS BRANCH MERGED" HALF OF boardNow(), CACHED PER REPO.
 *
 * Measured on the live app idle (.agx-tmp/measured.md): >=40 git subprocesses
 * in 17.6s, several repos deep, nobody touching anything. The cause was this
 * loop in boardNow() redoing `worktree list`, `rev-parse --abbrev-ref HEAD`
 * and `for-each-ref --merged` from scratch on every single call — and the
 * Lantern rail (always mounted) polls /agents/board every 5-20s forever
 * (web/src/lib/lanternStore.ts). Without the cache, two boardNow() calls a
 * few seconds apart run those three git commands twice; with it, once.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-landed-"));
process.env.AGENTGLASS_DB = join(dir, "landed.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.TMUX_TMPDIR = join(dir, "tmux");
delete process.env.AGENTGLASS_ROOT;

/* A tmux that answers "no panes" — boardNow() only needs the claimed worktree
   from AgentBoard.saidBy below, not a real pane. */
const tmuxBin = join(dir, "tmux-quiet");
writeFileSync(tmuxBin, "#!/bin/sh\nexit 0\n");
chmodSync(tmuxBin, 0o755);
process.env.AGENTGLASS_TMUX_PATH = tmuxBin;

/* A counting `git`: logs every invocation's args, then runs the real binary.
   Put first on PATH so Bun.spawn(["git", ...]) in lantern.ts's runGitIn finds
   it before /usr/bin/git. */
const binDir = join(dir, "bin");
mkdirSync(binDir);
const logFile = join(dir, "git-calls.log");
writeFileSync(logFile, "");
writeFileSync(
  join(binDir, "git"),
  `#!/bin/sh\necho "$@" >> "${logFile}"\nexec /usr/bin/git "$@"\n`,
);
chmodSync(join(binDir, "git"), 0o755);
/* Given back in afterAll: proc-detail.test.ts compares process.env.PATH with the PATH the
   process started with (/proc/self/environ), and a leaked prefix made it fail in the tranche. */
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${binDir}:${process.env.PATH}`;

/* A real, tiny repo: one commit on main. for-each-ref/worktree-list need an
   actual .git to answer from. */
const repo = join(dir, "repo");
mkdirSync(repo);
const run = (cmd: string) => { require("node:child_process").execSync(cmd, { cwd: repo, stdio: "pipe" }); };
run("/usr/bin/git init -q -b main");
run("/usr/bin/git -c user.email=t@t -c user.name=t commit --allow-empty -q -m first");

const calls = (needle: string): number =>
  require("node:fs").readFileSync(logFile, "utf8").split("\n").filter((l: string) => l.includes(needle)).length;

let lantern: typeof import("../src/lantern.ts");
let Board: typeof import("../src/agentboard.ts");

beforeAll(async () => {
  lantern = await import("../src/lantern.ts");
  Board = await import("../src/agentboard.ts");
  Board.saidBy({ name: "landed-cache-worker", doing: "idling", worktree: repo, branch: "main" });
});

afterAll(() => {
  delete process.env.AGENTGLASS_TMUX_PATH;
  process.env.PATH = ORIGINAL_PATH;
});

describe("boardNow()'s per-repo landed check", () => {
  test("runs for-each-ref once across two calls inside the TTL, not once per call", async () => {
    await lantern.boardNow();
    const after1 = calls("for-each-ref");
    expect(after1).toBe(1);

    await lantern.boardNow();
    const after2 = calls("for-each-ref");
    expect(after2).toBe(1); // still 1: the second call was a cache hit
  });

  test("asks again once the cache is cleared (the TTL path still works)", async () => {
    lantern.__resetGitFacts();
    await lantern.boardNow();
    expect(calls("for-each-ref")).toBe(2);
  });
});
