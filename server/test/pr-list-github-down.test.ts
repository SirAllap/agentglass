import { afterAll, describe, expect, it } from "bun:test";

/*
 * A pull request list that could not be read must not look like a repository
 * with no pull requests. With nothing cached (a first load, a filter or search
 * never read before) a failed read stored an empty list with no error and a
 * fresh time, so the panel said "nothing here, updated just now".
 *
 * A child bun with a fake `gh` that fails every request, because PATH applies
 * to Bun.which only at start and the module's caches begin empty.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-pr-down-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const GH = `#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then exit 1; fi
if [ "$1" = "auth" ]; then echo "Logged in to github.com account ada (keyring)"; exit 0; fi
echo "HTTP 500: Server Error" >&2
exit 1
`;

const DRIVER = `
const [repo, filter] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let l = await P.listPrs(repo, filter, "open", true, undefined, filter === "all" ? "cold" : undefined);
for (let i = 0; i < 100 && (l.loading || !l.fetchedAt); i++) { await sleep(50); l = await P.listPrs(repo, filter, "open", false, undefined, filter === "all" ? "cold" : undefined); }
console.log(JSON.stringify({ prs: l.prs.length, error: l.error ?? null, dataAt: l.dataAt ?? null }));
process.exit(0);
`;

const readFor = async (filter: string) => {
  if (!existsSync(REPO)) {
  await Bun.$`mkdir -p ${BIN} ${join(TMP, "state")}`.quiet();
  writeFileSync(join(BIN, "gh"), GH);
  chmodSync(join(BIN, "gh"), 0o755);
  writeFileSync(join(TMP, "driver.ts"), DRIVER);
  const sh = async (...a: string[]) => { await Bun.$`${a}`.quiet(); };
  await sh("git", "init", "-q", REPO);
  const g = (...a: string[]) => sh("git", "-C", REPO, "-c", "user.email=ada@example.test", "-c", "user.name=Ada Test", ...a);
  await g("commit", "-q", "--allow-empty", "-m", "one");
  await g("remote", "add", "origin", "https://github.com/acme/orbit.git");
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(AGENTGLASS_|XDG_|GIT_|GH_)/.test(k)) env[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", join(TMP, "driver.ts"), REPO, filter], {
    env: {
      ...env, NODE_ENV: "test", PATH: `${BIN}:${process.env.PATH}`,
      AGENTGLASS_ROOT: TMP, AGENTGLASS_CACHE_DIR: join(TMP, "cache"), AGENTGLASS_STATE_DIR: join(TMP, "state"),
      AGENTGLASS_DB: join(TMP, "state", "agx.db"), XDG_CONFIG_HOME: join(TMP, "xdg", "config"),
      XDG_DATA_HOME: join(TMP, "xdg", "data"), XDG_CACHE_HOME: join(TMP, "xdg", "cache"), XDG_STATE_HOME: join(TMP, "xdg", "state"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  try { return JSON.parse(stdout.trim().split("\n").pop() || "") as { prs: number; error: string | null; dataAt: number | null }; }
  catch { throw new Error(`driver said: ${stdout}${stderr}`); }
};

describe("a first load while GitHub fails", () => {
  /* "all" is a plain list; "mine" and "review" are the board's two queues, read by another path that had no error to give. */
  for (const filter of ["all", "mine", "review"]) {
    it(`says it could not read ${filter}, and does not claim fresh data`, async () => {
      const read = await readFor(filter);
      expect(read.prs).toBe(0);
      expect(read.error).not.toBeNull();
      expect(read.dataAt).toBe(0);
    });
  }
});
