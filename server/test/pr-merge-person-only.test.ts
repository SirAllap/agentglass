// Only the person merges. `/prs/merge` (and arming auto-merge, and a close)
// used to take any token the server knows, so a worker could merge an
// unlocked pull request through the panel's own route. The refusal is the
// merge lock's test (mayPublishReview) and happens before gh is ever called:
// the fake gh logs every call, which is how "nothing reached GitHub" is shown.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeFixture, populateHome, type Fixture } from "./diskcleanFixture.ts";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { personOnlyPrRefusal, MERGE_REFUSED, CLOSE_REFUSED, APPROVE_RUNS_REFUSED } from "../src/personOnlyPrRoutes.ts";

describe("personOnlyPrRefusal", () => {
  test("an agent is refused a merge, an auto-merge and a close, with the rule as the sentence", () => {
    expect(personOnlyPrRefusal("/prs/merge", {}, false)).toEqual({ ok: false, error: MERGE_REFUSED, status: 403 });
    expect(personOnlyPrRefusal("/prs/merge", { auto: true }, false)?.error).toBe(MERGE_REFUSED);
    expect(personOnlyPrRefusal("/prs/close", {}, false)?.error).toBe(CLOSE_REFUSED);
    expect(personOnlyPrRefusal("/prs/unstick-close", {}, false)?.status).toBe(403);
    expect(personOnlyPrRefusal("/prs/approve-runs", {}, false)).toEqual({ ok: false, error: APPROVE_RUNS_REFUSED, status: 403 });
    expect(MERGE_REFUSED).toBe("Only the person merges; an agent cannot.");
  });
  test("the person passes; anyone may cancel an armed auto-merge; other routes are not this gate's", () => {
    for (const p of ["/prs/merge", "/prs/close", "/prs/unstick-close", "/prs/approve-runs"]) expect(personOnlyPrRefusal(p, { auto: true }, true)).toBeNull();
    expect(personOnlyPrRefusal("/prs/merge", { disableAuto: true }, false)).toBeNull();
    expect(personOnlyPrRefusal("/prs/comment", {}, false)).toBeNull();
  });
});

const TOKEN = "orbit-merge-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "x-agentglass-desk", KEY = "k".repeat(48);
let fx: Fixture;
/** A checkout with a GitHub remote, so a merge that passes the gate goes on to the fake gh. */
let repo = "";
let base = "", proc: ReturnType<typeof Bun.spawn> | null = null, claim: AbortController | null = null;

beforeAll(async () => {
  fx = makeFixture();
  repo = populateHome(fx).repo;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      ...fx.env,
      PATH: [fx.shim, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, CLAUDE_CONFIG_DIR: join(fx.dir, ".claude"), AGENTGLASS_ROOT: fx.dir,
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_STATE_DIR: join(fx.dir, "state-merge"), AGENTGLASS_DB: join(fx.dir, "merge.db"),
      // a sandboxed run has no writable /tmp; its own TMPDIR carries through
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) {
        claim = new AbortController();
        const r = await fetch(base + "/desk/claim", { method: "POST", headers: { ...AUTH, [DESK]: KEY }, signal: claim.signal });
        if (r.status !== 200) throw new Error("the desk claim was refused: " + r.status);
        return;
      }
    } catch (e) { if (String(e).includes("desk claim")) throw e; }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc!.stderr as ReadableStream).text()).slice(0, 600));
}, SERVER_BOOT_MS);
afterAll(() => {
  try { claim?.abort(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* gone */ }
  rmSync(fx.dir, { recursive: true, force: true });
});
beforeEach(() => writeFileSync(fx.log, ""));

const ghMerges = () => readFileSync(fx.log, "utf8").split("\n").filter((l) => /\bgh\b.*(\bpr (merge|close)\b|\/approve\b|actions\/runs)/.test(l));
const person = { origin: "", [DESK]: KEY };
const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) });
const agents = (): [string, Record<string, string>][] => [
  ["the machine token alone (what a worker holds)", {}],
  ["the window's origin and desk key, presenting an agent's name", { ...person, origin: base, "x-agentglass-agent": "bug-fixer" }],
];

const refusalOf = (path: string) => path === "/prs/merge" ? MERGE_REFUSED : path === "/prs/approve-runs" ? APPROVE_RUNS_REFUSED : CLOSE_REFUSED;

describe("POST /prs/merge, /prs/close, /prs/approve-runs: person only", () => {
  for (const [who, h] of agents()) {
    for (const [path, body] of [["/prs/merge", { method: "squash" }], ["/prs/merge", { method: "squash", auto: true }], ["/prs/close", {}], ["/prs/approve-runs", { headSha: "a".repeat(40) }]] as const) {
      test(`GUARD: ${who} is refused ${path}${"auto" in body ? " (auto-merge)" : ""}, and gh is never called`, async () => {
        const r = await post(path, { root: repo, number: 7, ...body }, h);
        expect(r.status).toBe(403);
        expect(((await r.json()) as { error: string }).error).toBe(refusalOf(path));
        expect(ghMerges()).toEqual([]);
      });
    }
  }

  test("the person's window passes the gate: the merge goes on to GitHub (the fake gh)", async () => {
    const r = await post("/prs/merge", { root: repo, number: 7, method: "squash" }, { ...person, origin: base });
    expect(r.status).not.toBe(403);
    expect(((await r.json()) as { error?: string }).error ?? "").not.toBe(MERGE_REFUSED);
    expect(ghMerges().length).toBeGreaterThan(0);
  });

  test("an agent may still cancel an armed auto-merge", async () => {
    const r = await post("/prs/merge", { root: repo, number: 7, disableAuto: true }, {});
    expect(((await r.json()) as { error?: string }).error ?? "").not.toBe(MERGE_REFUSED);
  });
});
