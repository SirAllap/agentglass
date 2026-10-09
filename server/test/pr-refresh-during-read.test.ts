/*
 * A Refresh pressed while a read is already running is not the answer of that
 * read.
 *
 * `refreshList` returned at once when a read for the same list was in flight,
 * so a forced Refresh joined a poll that had begun BEFORE the press and the
 * change it was pressed for was missed until the next poll: seen as a press
 * that "did nothing" and needed a second. The forced ask now runs after the
 * one in flight. Child process with a stub `gh` first on its PATH and a slow,
 * counted `fetch`; see fixtures/pr-refresh-during-read-child.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-refresh-during-"));
const bin = join(dir, "bin");
const repo = join(dir, "orbit");
const ghLog = join(dir, "gh.log");
let out: { rows: number[]; asked: string[]; rowsAfterWrite: number[]; askedAfterWrite: number; stamps: { fetchedAt: number; startedAt?: number } } | null = null;
let failure = "";

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  // Only what the list path asks of gh: who is signed in, and the token. Any
  // other call is logged, and the test fails on it (a `gh api graphql` would be
  // a request the fetch counter cannot see).
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "auth status") echo "Logged in to github.com account octo-dev (keyring)"; exit 0;;',
    '  "auth token") echo "stub-token"; exit 0;;',
    "esac",
    `echo "$*" >> "${ghLog}"`,
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/acme/orbit.git");

  const home = join(dir, "home");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    NODE_ENV: "test",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AGENTGLASS_STATE_DIR: join(dir, "state"),
    AGENTGLASS_DB: join(dir, "agentglass.db"),
    AGENTGLASS_CACHE_DIR: join(dir, "cache"),
    TMUX_TMPDIR: join(dir, "tmux"),
  };
  delete env.TMUX;
  const child = Bun.spawn(["bun", new URL("./fixtures/pr-refresh-during-read-child.ts", import.meta.url).pathname, repo], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [so, se, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = so.trim().split("\n").pop() ?? "";
  try { out = JSON.parse(line); } catch { failure = `exit ${code}: ${se.slice(-2000)} ${so.slice(-500)}`; }
}, 30_000);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("a Refresh during a read", () => {
  it("ran against the stub, not the network", () => {
    expect(failure).toBe("");
    expect(out).not.toBeNull();
  });
  it("still sees what changed after that read began", () => {
    expect(out!.rows).toEqual([1, 2, 9]);
  });
  it("cost one more request, not one per press", () => {
    expect((out as any).asked.length).toBe(2);
  });
  it("drops a read that began before a write instead of keeping it as fresh", () => {
    expect(out!.rowsAfterWrite).toEqual([1, 2, 9]);
    expect(out!.askedAfterWrite).toBe(2);
  });
  it("stamps the list with when its read STARTED, not when it ended", () => {
    const { fetchedAt, startedAt } = out!.stamps;
    // the stub GitHub takes 400 ms to answer
    expect(typeof startedAt).toBe("number");
    expect(fetchedAt - startedAt!).toBeGreaterThanOrEqual(300);
  });
});
