import { afterAll, describe, expect, it } from "bun:test";

/*
 * An in-app label change reaches the plugins at once, and costs one detail
 * read of that pull request, not a re-read of the lists.
 *
 * `gh pr edit` answers with a URL and nothing else, so the new labels have to
 * be read back. The driver runs in a child bun with a fake `gh` that writes
 * every call it gets to a log, so "no extra list request" is a count of
 * `search(` calls before and after, not a claim:
 *   - the list is read once (cold) and seeds the baseline: no event;
 *   - setLabels adds a label: one event with added=[...], zero list reads, one
 *     detail read, and the cached row already carries the label;
 *   - a second edit inside the 3 s guard: no read of any kind, the cached row
 *     still follows by the names it was given.
 * A child process because PATH (for the fake gh) applies to Bun.which only at
 * start, and the module's caches begin empty.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-pr-changed-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const LOG = join(TMP, "gh.log");
const LABELS = join(TMP, "labels.txt");
const HEAD = "a".repeat(40);

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const GH = `#!/usr/bin/env bash
echo "$*" | tr "\\n" " " | cut -c1-4000 >> ${LOG}
all="$*"
labels() { tr '\\n' ',' < ${LABELS} | sed 's/,$//' | awk -F, '{for(i=1;i<=NF;i++) printf "%s{\\"name\\":\\"%s\\",\\"color\\":\\"ededed\\"}", (i>1?",":""), $i}'; }
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then exit 1; fi
if [ "$1" = "auth" ]; then echo "Logged in to github.com account ada (keyring)"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --add-label) echo "$2" >> ${LABELS}; shift 2;;
      --remove-label) grep -vx "$2" ${LABELS} > ${LABELS}.n; mv ${LABELS}.n ${LABELS}; shift 2;;
      *) shift;;
    esac
  done
  echo "https://github.com/acme/orbit/pull/1042"; exit 0
fi
node() { echo '{"number":1042,"title":"Add the thing","state":"OPEN","isDraft":false,"url":"https://github.com/acme/orbit/pull/1042","headRefName":"feat","headRefOid":"${HEAD}","baseRefName":"main","updatedAt":"2026-01-01T00:00:00Z","createdAt":"2026-01-01T00:00:00Z","author":{"login":"ada"},"labels":{"nodes":['"$(labels)"']},"assignees":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"${HEAD}"}}]}}'; }
case "$all" in
  *"search("*) echo '{"data":{"search":{"issueCount":1,"nodes":['"$(node)"'],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}'; exit 0;;
  *'pullRequest(number:$number)'*) echo '{"data":{"repository":{"pullRequest":'"$(node)"'}}}'; exit 0;;
esac
echo '{"data":{}}'
`;

const DRIVER = `
const [repo] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const C = await import(${JSON.stringify(join(import.meta.dir, "../src/prChanged.ts"))});
const { readFileSync } = await import("node:fs");
const events = [];
C.__resetPrChanged({ coalesceMs: 60, guardMs: 3000 });
C.onPrChanged((e) => events.push(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => readFileSync(${JSON.stringify(LOG)}, "utf8").split("\\n").filter(Boolean);
const lists = () => log().filter((l) => l.includes("search(")).length;
// One detail read is two requests side by side (the pull request and its merge gate); the first carries the labels.
const details = () => log().filter((l) => l.includes("labels(first:50)")).length;
const out = {};
let l = await P.listPrs(repo, "all", "open", true);
for (let i = 0; i < 100 && (l.loading || l.checksPending || !l.prs.length); i++) { await sleep(50); l = await P.listPrs(repo, "all", "open"); }
await sleep(150);
out.seeded = l.prs.map((p) => p.labels.map((x) => x.name));
out.eventsAfterList = events.length;
const l0 = lists(), d0 = details();
out.edit = await P.setLabels(repo, 1042, ["agentglass-review"], []);
await sleep(300);
out.events = events.slice();
out.listCalls = lists() - l0;
out.detailCalls = details() - d0;
const after = await P.listPrs(repo, "all", "open");
out.rowLabels = after.prs.map((p) => p.labels.map((x) => x.name));
out.listCallsAfterRead = lists() - l0;
const d1 = details();
out.edit2 = await P.setLabels(repo, 1042, ["second"], []);
await sleep(300);
out.detailCallsGuarded = details() - d1;
out.eventsAfterGuarded = events.length;
const again = await P.listPrs(repo, "all", "open");
out.rowLabels2 = again.prs.map((p) => p.labels.map((x) => x.name));
console.log(JSON.stringify(out));
process.exit(0);
`;

const read = await (async () => {
  await Bun.$`mkdir -p ${BIN} ${join(TMP, "state")}`.quiet();
  writeFileSync(LOG, "");
  writeFileSync(LABELS, "bug\n");
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
  const line = stdout.trim().split("\n").pop() || "";
  try { return JSON.parse(line) as any; } catch { throw new Error(`driver said: ${stdout}${stderr}\n${readFileSync(LOG, "utf8").slice(0, 2000)}`); }
})();

describe("an in-app label change", () => {
  it("the first list read is a baseline: no event", () => {
    expect(read.seeded).toEqual([["bug"]]);
    expect(read.eventsAfterList).toBe(0);
  });

  it("fires one event with the added label and the final set", () => {
    expect(read.edit.ok).toBe(true);
    expect(read.events).toHaveLength(1);
    expect(read.events[0]).toMatchObject({ type: "pr-changed", repo: "acme/orbit", number: 1042, head: HEAD, labels: ["agentglass-review", "bug"], added: ["agentglass-review"], removed: [], headChanged: false });
  });

  it("costs one detail read and no list read", () => {
    expect(read.detailCalls).toBe(1);
    expect(read.listCalls).toBe(0);
    expect(read.listCallsAfterRead).toBe(0);
  });

  it("the cached row already carries the label", () => {
    expect(read.rowLabels[0]).toContain("agentglass-review");
  });

  it("a second edit inside the guard window reads nothing and still moves the row", () => {
    expect(read.detailCallsGuarded).toBe(0);
    expect(read.eventsAfterGuarded).toBe(1);
    expect(read.rowLabels2[0]).toContain("second");
  });
});
