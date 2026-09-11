/*
 * The warning that arrives while the token still works.
 *
 * A token expired at the end of August and the snapshot went red every
 * morning for a fortnight. Nothing was wrong with the job: it failed, said so,
 * and said it in a log. By the time a red run was opened, the fourteen-day
 * window it exists to preserve had rolled past every day it held, and those
 * days are gone from GitHub too.
 *
 * So what is pinned here is the notice, not the failure. GitHub answers every
 * authenticated request with `github-authentication-token-expiration`, and the
 * script turns that into days of runway: below the threshold it says so on a
 * run that otherwise succeeded, and hands the number to the workflow, which
 * raises it as an issue. Above it, it must stay quiet — a warning every
 * morning for a year is the same log nobody reads, wearing a different hat.
 *
 * Driven against the real script with GITHUB_API_URL pointed at a stub,
 * because the decision is made from a response header and asserting on the
 * source text would pass against a version that never reads one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/traffic-snapshot.mjs", import.meta.url).pathname;
const REPO = "acme/orbit";

/** What the endpoints answer. Shapes copied from a real response: views and
 *  clones are per-day buckets, referrers and paths are flat 14-day rollups. */
const BODIES: Record<string, unknown> = {
  views: { count: 167, uniques: 19, views: [{ timestamp: "2026-09-10T00:00:00Z", count: 167, uniques: 19 }] },
  clones: { count: 8, uniques: 6, clones: [{ timestamp: "2026-09-10T00:00:00Z", count: 8, uniques: 6 }] },
  "popular/referrers": [{ referrer: "github.com", count: 24, uniques: 9 }],
  "popular/paths": [{ path: "/acme/orbit", title: "orbit", count: 12, uniques: 7 }],
};

/** Set per test: the expiry header to answer with, or null to answer without
 *  one — which is what GitHub does for a token that never expires. */
let expiry: string | null = null;
/** Set per test: an HTTP status to answer with instead of the body. */
let status = 200;

let base = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.replace(`/repos/${REPO}/traffic/`, "");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (expiry) headers["github-authentication-token-expiration"] = expiry;
      if (status !== 200) return new Response("{}", { status, headers });
      return Response.json(BODIES[path] ?? {}, { headers });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const trash: string[] = [];
afterAll(() => { for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The header as GitHub spells it, a given number of days out. The extra hour
 *  keeps the child's own clock from rounding the day down under it. */
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/**
 * Run the script against the stub and read back everything it said.
 *
 * Spawned asynchronously, not with spawnSync: the stub above is served on this
 * process's own event loop, so a blocking wait here means the child's request
 * is never answered and the two sit staring at each other until the suite is
 * killed.
 */
async function run() {
  const dir = mkdtempSync(join(tmpdir(), "traffic-"));
  trash.push(dir);
  const envFile = join(dir, "github-env");

  const child = Bun.spawn([process.execPath, SCRIPT, join(dir, "data")], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: REPO,
      TRAFFIC_TOKEN: "stub-token",
      // Always ours. Inherited, this would append to the runner's own env file.
      GITHUB_ENV: envFile,
      // The stub is on this machine; a proxy in the ambient environment would
      // take the request somewhere else entirely.
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
  });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, out: `${out}${err}`, raised: existsSync(envFile) ? readFileSync(envFile, "utf8") : "" };
}

describe("the traffic token's remaining runway", () => {
  test("a token inside the window is called out on a run that succeeded", async () => {
    expiry = inDays(6);
    status = 200;
    const r = await run();

    expect(r.code).toBe(0);
    expect(r.out).toContain("expires in 6 days");
    // The number goes to the workflow, which is what turns it into an issue.
    expect(r.raised.trim()).toBe("TRAFFIC_TOKEN_DAYS=6");
    // And the run still did its job, which is the whole point of not failing.
    expect(r.out).toContain("1 days of views");
  });

  test("the day before is still a warning, and reads as one day", async () => {
    expiry = inDays(1);
    status = 200;
    const r = await run();

    expect(r.out).toContain("expires in 1 day,");
    expect(r.out).not.toContain("1 days,");
  });

  test("a token with a year on it says nothing anybody has to read", async () => {
    expiry = inDays(365);
    status = 200;
    const r = await run();

    expect(r.code).toBe(0);
    expect(r.out).toContain("365 days left");
    expect(r.out).not.toContain("expires in");
    // Nothing raised means no issue opened: a warning that cries every morning
    // for a year is the log nobody reads with a different name on it.
    expect(r.raised).toBe("");
  });

  test("the fourteenth day is inside the window, the fifteenth is not", async () => {
    status = 200;

    expiry = inDays(14);
    expect((await run()).raised.trim()).toBe("TRAFFIC_TOKEN_DAYS=14");

    expiry = inDays(15);
    expect((await run()).raised).toBe("");
  });

  test("a bare date and a timestamp for the same instant agree", async () => {
    status = 200;

    // Both spellings have come back from the API. Pinned against the same
    // midnight rather than against a fixed number of days, because a bare date
    // IS midnight — asking for "three days out" in each and expecting the same
    // count would only be testing that the fixture dropped a time of day.
    const day = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);

    expiry = day;
    const bare = await run();
    expiry = `${day} 00:00:00 UTC`;
    const full = await run();

    // The message quotes the header back verbatim, so the strings differ by
    // the ` 00:00:00 UTC` the bare spelling does not carry. What has to match
    // is the count taken off it, and the verdict handed to the workflow.
    const countIn = (out: string) => out.match(/expires in (\d+) days?,/)?.[1];

    expect(countIn(bare.out)).not.toBeUndefined();
    expect(countIn(full.out)).toBe(countIn(bare.out));
    expect(full.raised).toBe(bare.raised);
  });

  test("no header is no answer, not zero days", async () => {
    expiry = null;
    status = 200;
    const r = await run();

    expect(r.code).toBe(0);
    expect(r.out).toContain("no expiry date");
    // Absent is how GitHub spells a token that never expires. Reading it as
    // zero would open an issue every morning about a token that is fine.
    expect(r.raised).toBe("");
    expect(r.out).not.toContain("expires in");
  });
});

describe("the fault the log has to name", () => {
  test("a 401 is the credential, and says which fix that is", async () => {
    expiry = null;
    status = 401;
    const r = await run();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("expired, revoked or replaced");
    // Not the 403 sentence: that one is a valid token without the access, and
    // sending somebody to re-grant a permission on a dead token wastes the day.
    expect(r.out).not.toContain("These endpoints need push access");
  });

  test("a 403 keeps its own sentence", async () => {
    expiry = null;
    status = 403;
    const r = await run();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("These endpoints need push access");
    expect(r.out).not.toContain("expired, revoked or replaced");
  });
});

/*
 * The other half: the step that puts it where somebody will see it.
 *
 * The fortnight was not lost because the job stayed quiet — it said so every
 * morning, into a log. What was missing was a place to say it that is read
 * without being gone looking for, so the workflow now keeps one issue: opened
 * when the record is not being kept or the token is running out, edited rather
 * than reposted while that stays true, and closed by the first run that works.
 *
 * Lifted out of the workflow and driven against a stub client, because it is
 * real code that otherwise runs unattended once a day and has no other reader.
 * It is invoked the way the action invokes it — an async function body with
 * `github` and `context` in scope — so a `return` in the middle means here
 * what it means there.
 */
const WORKFLOW = new URL("../../.github/workflows/traffic.yml", import.meta.url).pathname;
const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
  jobs: { snapshot: { steps: Array<{ name?: string; env?: unknown; with?: { script?: string } }> } };
};
const STEP = workflow.jobs.snapshot.steps.find((s) => s.with?.script);
const HEALTH = STEP?.with?.script;

type Issue = { number: number; body?: string | null; pull_request?: object };
type Call = Record<string, unknown>;

/** github-script hands the body `github` and `context`; this hands it the same
 *  two, recording what it asks the API to do instead of doing it. */
function drive(open: Issue[], env: { JOB: string; DAYS?: string }) {
  const created: Call[] = [];
  const updated: Call[] = [];
  const commented: Call[] = [];

  const github = {
    paginate: async (fn: () => Issue[]) => fn(),
    rest: {
      issues: {
        listForRepo: () => open,
        create: async (a: Call) => void created.push(a),
        update: async (a: Call) => void updated.push(a),
        createComment: async (a: Call) => void commented.push(a),
      },
    },
  };

  const before = { JOB: process.env.JOB, DAYS: process.env.DAYS, RUN: process.env.RUN };
  process.env.JOB = env.JOB;
  process.env.RUN = "https://github.com/acme/orbit/actions/runs/1";
  if (env.DAYS === undefined) delete process.env.DAYS;
  else process.env.DAYS = env.DAYS;

  const body = new Function(
    "github",
    "context",
    `return (async () => {\n${HEALTH}\n})()`,
  ) as (g: unknown, c: unknown) => Promise<void>;

  return body(github, { repo: { owner: "acme", repo: "orbit" } })
    .then(() => ({ created, updated, commented }))
    .finally(() => {
      // This suite shares one process with every other file in it.
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const MARKER = "<!-- traffic-health -->";
const standing: Issue = { number: 42, body: `${MARKER}\nThe traffic record is not being kept` };

describe("raising it where it will be seen", () => {
  test("the step is still in the workflow and still has a body", () => {
    expect(HEALTH).toBeTypeOf("string");
    expect(HEALTH).toContain(MARKER);
  });

  test("it is the job's health it reads, not one step's outcome", () => {
    /*
     * Asserted against the workflow rather than driven, because this is the
     * one input the tests below cannot reach: they set JOB themselves, so a
     * binding that reads the wrong thing would let every one of them pass.
     *
     * And reading the wrong thing is silent in the worst direction. Only the
     * first of the two steps talks to the API; if the push that follows it is
     * refused, that step is still green and the day is still unrecorded — so
     * a binding to the step would close the standing issue and call it fixed.
     */
    expect((STEP?.env as Record<string, string> | undefined)?.JOB).toBe("${{ job.status }}");
  });

  test("a job that failed opens one issue, carrying the run that failed", async () => {
    const { created, updated } = await drive([], { JOB: "failure" });

    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe("The traffic record is not being kept");
    expect(String(created[0]!.body)).toContain(MARKER);
    expect(String(created[0]!.body)).toContain("actions/runs/1");
    expect(updated).toHaveLength(0);
  });

  test("failing again edits the one that is open instead of opening another", async () => {
    const { created, updated, commented } = await drive([standing], { JOB: "failure" });

    // Every morning for a fortnight is how long the last one went unseen. A
    // fresh issue a day would be the same silence wearing a different hat.
    expect(created).toHaveLength(0);
    expect(commented).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.issue_number).toBe(42);
  });

  test("a token running out is raised even though the run went fine", async () => {
    const { created } = await drive([], { JOB: "success", DAYS: "9" });

    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe("The traffic token expires in 9 days");
    expect(String(created[0]!.body)).toContain("nothing has been lost yet");
  });

  test("a run that works closes the standing issue, and says why", async () => {
    const { updated, commented, created } = await drive([standing], { JOB: "success" });

    expect(created).toHaveLength(0);
    expect(commented).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.state).toBe("closed");
    expect(updated[0]!.state_reason).toBe("completed");
  });

  test("a healthy run with nothing open touches nothing", async () => {
    const { created, updated, commented } = await drive([], { JOB: "success" });

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(commented).toHaveLength(0);
  });

  test("an open pull request is not mistaken for the standing issue", async () => {
    // listForRepo answers with pull requests too, and one of ours quoting the
    // marker would otherwise be edited in place of the issue — or worse, read
    // as proof that the issue is already open and stop a real one being filed.
    const pr: Issue = { number: 7, body: `${MARKER} quoted in a pull request`, pull_request: {} };
    const { created, updated } = await drive([pr], { JOB: "failure" });

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);
  });
});
