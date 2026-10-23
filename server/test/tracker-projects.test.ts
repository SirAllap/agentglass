/*
 * The per-repository tracker choice, and the Jira card's pull requests, through
 * a real server.
 *
 * Two things a mistake costs. A choice that does not survive a restart is a
 * setting the person has to make again after every update. And a card-to-pull-
 * request search that trusts GitHub's own idea of a match links a pull request
 * that merely mentions a number (the reason `cardPullRequests` re-checks every
 * row), so the stub `gh` here returns the wrong rows on purpose and the answer
 * is checked against them. `gh` is a stub on the child's PATH, and every call
 * it gets is written to a file so "how many searches" is counted.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { __setTrackerProjectsPath, setTrackerChoice, trackerProjects } from "../src/trackerProjects.ts";

const TOKEN = "machine-token-for-the-tracker-routes";
let dir = "", base = "", calls = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

const rows = [
  { number: 91, title: "Sync the board", state: "OPEN", url: "https://github.com/acme/orbit/pull/91", body: "", headRefName: "feat/ORBIT-1042-sync", author: { login: "ada" } },
  { number: 77, title: "Unrelated", state: "OPEN", url: "https://github.com/acme/orbit/pull/77", body: "mentions ORBIT-10420 only", headRefName: "fix/other", author: { login: "lin" } },
  { number: 64, title: "Search said so", state: "OPEN", url: "https://github.com/acme/orbit/pull/64", body: "page 1042 of the report", headRefName: "fix/pages", author: { login: "lin" } },
];

async function boot(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      AGX_STUB_ROWS: join(dir, "rows.json"), AGX_STUB_CALLS: calls,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "t.db"),
      AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "pipe", stderr: "pipe",
  });
  for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) {
    void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
  }
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + output.slice(0, 400));
}

async function stop(): Promise<void> {
  const p = proc;
  proc = null;
  if (!p) return;
  try { p.kill(); } catch { /* already gone */ }
  await p.exited;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-tracker-projects-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  calls = join(dir, "calls.txt");
  writeFileSync(calls, "");
  writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
  const stub = join(dir, "bin", "gh");
  writeFileSync(stub, `#!/bin/sh
echo "$@" >> "$AGX_STUB_CALLS"
case "$1" in
  api) echo ada ;;
  pr) cat "$AGX_STUB_ROWS" ;;
esac
`);
  chmodSync(stub, 0o755);
  await boot();
}, SERVER_BOOT_MS);

afterAll(async () => {
  await stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const get = async (path: string) => {
  const r = await fetch(base + path, { headers });
  return { status: r.status, body: await r.json() as Record<string, any> };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, any> };
};
const file = () => join(dir, "agentglass", "tracker-projects.json");
const ghCalls = () => readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("pr list"));

const step = story();

describe("the choice, over HTTP", () => {
  step("starts empty, and asking writes nothing", async () => {
    expect((await get("/tracker/projects")).body).toEqual({ ok: true, projects: {} });
    expect(existsSync(file())).toBe(false);
  });

  step("a choice is stored, lower-cased, and read back", async () => {
    const r = await post("/tracker/projects", { repo: "Acme/Orbit", tracker: "jira" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, projects: { "acme/orbit": "jira" } });
    expect((await get("/tracker/projects")).body.projects).toEqual({ "acme/orbit": "jira" });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ "acme/orbit": "jira" });
  });

  step("it survives a restart", async () => {
    await stop();
    await boot();
    expect((await get("/tracker/projects")).body.projects).toEqual({ "acme/orbit": "jira" });
  });

  step("naming the repositories to choose for is asked for, not given", async () => {
    expect((await get("/tracker/projects")).body.repos).toBeUndefined();
    expect(Array.isArray((await get("/tracker/projects?repos=1")).body.repos)).toBe(true);
  });

  step("auto removes the entry instead of storing a word for nothing", async () => {
    await post("/tracker/projects", { repo: "acme/shop", tracker: "clickup" });
    const r = await post("/tracker/projects", { repo: "acme/orbit", tracker: "auto" });
    expect(r.body.projects).toEqual({ "acme/shop": "clickup" });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ "acme/shop": "clickup" });
  });

  step("a bad repository or tracker is a sentence and a 400, and changes nothing", async () => {
    const before = readFileSync(file(), "utf8");
    for (const b of [{ repo: "orbit", tracker: "jira" }, { repo: "../etc/passwd", tracker: "jira" }, { repo: "acme/orbit", tracker: "linear" }, { repo: "acme/orbit" }, {}]) {
      const r = await post("/tracker/projects", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(typeof r.body.error).toBe("string");
    }
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  step("a page in another origin cannot change it", async () => {
    const r = await fetch(base + "/tracker/projects", {
      method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify({ repo: "acme/orbit", tracker: "jira" }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ "acme/shop": "clickup" });
  });
});

describe("GET /jira/prs", () => {
  step("one search, and only the rows that name the key stay", async () => {
    writeFileSync(calls, "");
    const r = await get("/jira/prs?key=ORBIT-1042");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.prs.map((p: { number: number }) => p.number)).toEqual([91]);
    expect(r.body.prs[0]).toMatchObject({ number: 91, link: "own", mine: true });
    expect(ghCalls().length).toBe(1);
    expect(ghCalls()[0]).toContain("--search ORBIT-1042");
  });

  step("a key that is not one is refused before gh is asked", async () => {
    writeFileSync(calls, "");
    for (const k of ["", "1042", "ORBIT-", "ORBIT-1042 label:x", "--limit", "ORBIT-1042;ls", "-x-1"]) {
      const r = await get(`/jira/prs?key=${encodeURIComponent(k)}`);
      expect(r.body, k).toEqual({ ok: false, prs: [], error: "That is not a Jira card id" });
    }
    expect(ghCalls().length).toBe(0);
  });

  step("the ClickUp route answers as it did", async () => {
    writeFileSync(calls, "");
    const r = await get("/clickup/prs?card=ORBIT-1042&field=&root=&task=");
    expect(r.body.prs.map((p: { number: number }) => p.number)).toEqual([91]);
  });
});

describe("the store on its own", () => {
  const tmp = mkdtempSync(join(tmpdir(), "agx-tracker-store-"));
  afterAll(() => { __setTrackerProjectsPath(null); rmSync(tmp, { recursive: true, force: true }); });

  step("a hand-edited file keeps what is well-formed and drops the rest", () => {
    const p = join(tmp, "a.json");
    __setTrackerProjectsPath(p);
    writeFileSync(p, JSON.stringify({ "acme/orbit": "jira", "acme/shop": "both", "nope": "jira", "acme/api": 3, "Acme/Plat": "clickup" }));
    // Keys are read lower-cased, the way a choice is stored, so a hand edit with a capital still applies.
    expect(trackerProjects()).toEqual({ "acme/orbit": "jira", "acme/plat": "clickup" });
  });

  step("an unreadable file is an empty one, and a write replaces it whole", () => {
    const p = join(tmp, "b.json");
    __setTrackerProjectsPath(p);
    writeFileSync(p, "{not json");
    expect(trackerProjects()).toEqual({});
    expect(setTrackerChoice("acme/orbit", "clickup")).toEqual({ ok: true, projects: { "acme/orbit": "clickup" } });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "acme/orbit": "clickup" });
  });

  step("a file that is a list, or a string, is empty", () => {
    const p = join(tmp, "c.json");
    __setTrackerProjectsPath(p);
    for (const v of ["[]", '"jira"', "null", "3"]) { writeFileSync(p, v); expect(trackerProjects()).toEqual({}); }
  });
});

describe("GET /jira/prs?project=", () => {
  const pr = (number: number, o: Record<string, unknown>) => ({
    number, title: "", state: "OPEN", url: `https://github.com/acme/orbit/pull/${number}`, body: "", headRefName: "feat/x", author: { login: "ada" }, ...o,
  });
  const projectRows = [
    pr(91, { title: "Sync the board", headRefName: "feat/ORBIT-1042-sync" }),
    pr(92, { title: "Longer ids only", body: "touches ORBIT-991 and ORBIT-10420" }),
    pr(93, { title: "Prefixed by a letter", body: "see XORBIT-77" }),
    pr(94, { title: "Stacked", headRefName: "feat/ORBIT-1043-top", body: "Depends on #91 (ORBIT-1042)" }),
  ];

  step("one search for the whole project, each row given to the cards it names and to no others", async () => {
    writeFileSync(join(dir, "rows.json"), JSON.stringify(projectRows));
    writeFileSync(calls, "");
    const r = await get("/jira/prs?project=ORBIT&root=");
    expect(r.body.ok).toBe(true);
    expect(ghCalls().length).toBe(1);
    expect(ghCalls()[0]).toContain("--search ORBIT --state all --limit 200");
    const by = r.body.byCard as Record<string, { number: number; link: string }[]>;
    expect(Object.keys(by).sort()).toEqual(["ORBIT-10420", "ORBIT-1042", "ORBIT-1043", "ORBIT-991"].sort());
    // Asked for ORBIT-99 or ORBIT-77: nothing, the rows name longer or prefixed ids.
    expect(by["ORBIT-99"]).toBeUndefined();
    expect(by["ORBIT-77"]).toBeUndefined();
    // A stacked pull request is cut for one card and only mentions the other.
    expect(by["ORBIT-1043"]!.map((p) => [p.number, p.link])).toEqual([[94, "own"]]);
    expect(by["ORBIT-1042"]!.map((p) => [p.number, p.link])).toEqual([[94, "mention"], [91, "own"]]);
  });

  step("a project key that is not one is refused before gh is asked", async () => {
    writeFileSync(calls, "");
    for (const k of ["1", "ORBIT-1", "ORBIT label:x", "--limit", "ORBIT;ls", "-x"]) {
      expect((await get(`/jira/prs?project=${encodeURIComponent(k)}`)).body, k).toEqual({ ok: false, byCard: {}, error: "That is not a Jira project key" });
    }
    expect(ghCalls().length).toBe(0);
  });

  step("a search that was cut at the limit says so", async () => {
    writeFileSync(join(dir, "rows.json"), JSON.stringify(Array.from({ length: 200 }, (_, i) => pr(1000 + i, { title: `ORBIT-${i + 1}` }))));
    const r = await get("/jira/prs?project=ORBIT");
    expect(r.body.truncated).toBe(true);
  });
});
