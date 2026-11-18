import { afterAll, describe, expect, it } from "bun:test";

/*
 * The panel offers a second page from `hasNext` and `cursor`. A forced read
 * (Refresh, or ?force=1) answers from the placeholder entry `refreshList`
 * writes while the read runs, and that placeholder dropped both: the response
 * said hasNext:false, cursor:null with 20 rows, so the list stopped at 20 of
 * 200+. Here GitHub (a fake `gh`) says there is a next page, and the route's
 * answer must say so — during the read and after it — and `after=c1` must ask
 * GitHub for the next page.
 *
 * A child bun with a fake `gh`, because PATH applies to Bun.which only at start.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-pr-next-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const LOG = join(TMP, "gh.log");
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

/* 20 PRs per page. With no `after`: hasNextPage true, endCursor c1. With after=c1: the last page. */
const GH = `#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then exit 1; fi
if [ "$1" = "auth" ]; then echo "Logged in to github.com account ada (keyring)"; exit 0; fi
echo "$*" | grep -q 'after=c1' && echo "ASKED after=c1" >> "${LOG}"
sleep 0.3
if echo "$*" | grep -q 'after=c1'; then base=20; more=false; end=null; else base=0; more=true; end='"c1"'; fi
nodes=""
for i in $(seq 1 20); do n=$((base+i)); nodes="$nodes{\\"number\\":$n,\\"title\\":\\"PR $n\\",\\"url\\":\\"https://github.com/acme/orbit/pull/$n\\",\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"createdAt\\":\\"2026-01-01T00:00:00Z\\",\\"updatedAt\\":\\"2026-01-01T00:00:00Z\\",\\"baseRefName\\":\\"main\\",\\"headRefName\\":\\"b$n\\",\\"author\\":{\\"login\\":\\"ada\\"}},"; done
echo "{\\"data\\":{\\"search\\":{\\"issueCount\\":200,\\"pageInfo\\":{\\"hasNextPage\\":$more,\\"endCursor\\":$end},\\"nodes\\":[\${nodes%,}]}}}"
`;

const DRIVER = `
const [repo] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (l) => ({ n: l.prs.length, hasNext: l.hasNext, cursor: l.cursor, loading: l.loading });
const settle = async (after) => {
  let l = await P.listPrs(repo, "all", "open", false, after);
  for (let i = 0; i < 200 && (l.loading || !l.fetchedAt); i++) { await sleep(50); l = await P.listPrs(repo, "all", "open", false, after); }
  return l;
};
await settle();                                          // warm: page 1 is cached, hasNext true
const forced = await P.listPrs(repo, "all", "open", true); // Refresh while the read runs
const during = pick(forced);
const settled = pick(await settle());
const next = pick(await settle("c1"));
console.log(JSON.stringify({ during, settled, next }));
process.exit(0);
`;

const run = async () => {
  await Bun.$`mkdir -p ${BIN} ${join(TMP, "state")}`.quiet();
  writeFileSync(join(BIN, "gh"), GH);
  chmodSync(join(BIN, "gh"), 0o755);
  writeFileSync(join(TMP, "driver.ts"), DRIVER);
  const sh = async (...a: string[]) => { await Bun.$`${a}`.quiet(); };
  await sh("git", "init", "-q", REPO);
  const g = (...a: string[]) => sh("git", "-C", REPO, "-c", "user.email=ada@example.test", "-c", "user.name=Ada Test", ...a);
  await g("commit", "-q", "--allow-empty", "-m", "one");
  await g("remote", "add", "origin", "https://github.com/acme/orbit.git");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(AGENTGLASS_|XDG_|GIT_|GH_)/.test(k)) env[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", join(TMP, "driver.ts"), REPO], {
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
  try { return JSON.parse(stdout.trim().split("\n").pop() || ""); }
  catch { throw new Error(`driver said: ${stdout}${stderr}`); }
};

describe("a list with more pages than one", () => {
  it("keeps hasNext and the cursor through a forced read, and after=c1 asks for the next page", async () => {
    const r = await run();
    expect(r.settled).toMatchObject({ n: 20, hasNext: true, cursor: "c1" });
    expect(r.during).toMatchObject({ hasNext: true, cursor: "c1" });
    expect(r.next).toMatchObject({ n: 20, hasNext: false, cursor: null });
    expect(existsSync(LOG) && readFileSync(LOG, "utf8")).toContain("ASKED after=c1");
  });
});
