/*
 * The per-class seams, through the real routes.
 *
 * Two writes go through a live server — a commit and a gate decision — with a
 * canary in the one field of each that a careless seam would keep: the commit
 * message and the held command line. Both fields are legitimate somewhere else
 * in this server. The commit message ends up in git, where it belongs; the
 * command line ends up in the action log, which exists precisely so "who
 * allowed `rm -rf …`" has an answer.
 *
 * So the assertion is not "the string is nowhere". It is that the string went
 * all the way through, is provably present where it is supposed to be, and is
 * absent from every column of every understudy table. A test that only checked
 * absence would pass just as happily against a route that silently did nothing.
 *
 * The second half is about `/gate/decide` naming the same person as the audit
 * log. Two records of one press that can disagree about who made it are worse
 * than one record, because the disagreement is discovered during the argument
 * the records exist to settle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-the-capture-test";

/** The commit message. A real one, with a body, because "the message did not
 *  travel" is only interesting if there was a message. Fictional throughout —
 *  this repository is public. */
const COMMIT_TITLE = "fix(orbit): stop the widget eating orbit-canary-7b21e0";
const COMMIT_BODY = "The regression came in with orbit-canary-7b21e0 and nothing else touched it.";
const COMMIT_CANARY = "orbit-canary-7b21e0";

/** What the held tool call was going to run. This one is legitimately kept by
 *  the action log, which is the comparison the test turns on. */
const GATE_CANARY = "orbit-canary-3d90f4";

let dir = "", repo = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const git = (args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: dir } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-understudy-capture-"));
  dbFile = join(dir, "capture.db");
  repo = join(dir, "orbit");

  // The understudy records nothing unless it was switched on, which is the
  // whole promise; so the file it reads is written before the server starts.
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "understudy.json"), JSON.stringify({ enabled: true, modes: {} }));

  // An identity for the commit, in this HOME and nowhere near the developer's.
  writeFileSync(join(dir, ".gitconfig"),
    "[user]\n\tname = Test Person\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
  mkdirSync(repo, { recursive: true });
  git(["init"]);
  writeFileSync(join(repo, "note.txt"), "one line\n");

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      // Scopes the server to the scratch directory, which is what puts
      // `<dir>/orbit` inside the open project — `commit()` refuses outside it.
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) {
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
/** A browser's Origin. `/gate/decide` requires one (or a paired device) and
 *  `pressed()` reads the same header to decide this was a click rather than an
 *  agent's shell — which is what puts the row in the scored denominator. */
const ORIGIN = "http://127.0.0.1:5173";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (path: string, body: unknown, origin?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: origin ? { ...headers, origin } : headers,
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Json>);

function all(table: string): Record<string, unknown>[] {
  const db = new Database(dbFile);
  try {
    return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const decisions = (cls: string) =>
  all("understudy_ledger").filter((r) => r.kind === "decision" && r.class === cls);

describe("a commit", () => {
  let commit: Json;

  beforeAll(async () => {
    // With an Origin, because the commit box is a page in a browser. Without
    // one the same request is read as an agent's shell and the row lands as
    // `agent-tolerated`, out of the scored denominator — which is the rule, and
    // is asserted below rather than assumed here.
    commit = await post("/git/commit", {
      root: repo, files: ["note.txt"], title: COMMIT_TITLE, body: COMMIT_BODY,
    }, ORIGIN);
  });

  test("really happened, message and all", () => {
    // The premise. Everything below is about what the seam did NOT keep, and
    // that is only a claim if the route did the work.
    expect(commit.ok, JSON.stringify(commit)).toBe(true);
    const subject = git(["log", "-1", "--pretty=%s"]).stdout.toString().trim();
    const body = git(["log", "-1", "--pretty=%b"]).stdout.toString().trim();
    expect(subject).toBe(COMMIT_TITLE);
    expect(body).toBe(COMMIT_BODY);
  });

  test("leaves one C2 row, and it is the shape of the decision rather than the words of it", () => {
    const rows = decisions("C2");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // The subject is the repository, which is what a later seal for the same
    // class would be filed under. Never a path — a path is the machine.
    expect(row.subject).toBe("orbit");
    expect(row.repo).toBe("orbit");
    // SEALED, and this line changed the day a predictor arrived.
    //
    // It used to assert `unsealed = 1`, on the reasoning that nothing in v1
    // predicted anything so every decision arrived with no seal in front of it.
    // That reasoning was right and is now obsolete: the seam seals the
    // situation before the route runs, off a cloned body, so a commit is
    // written down before it happens whether or not anything guesses.
    //
    // The `unsealed` count is the trigger-recall denominator and the number
    // that makes this feature look worst, so it is worth being exact about
    // WHICH good thing this asserts: not that a prediction was right, but that
    // there was a moment, before the work, at which one could have been made.
    expect(row.unsealed).toBe(0);
    expect(row.situation_hash).not.toBe("");
    // And unscored all the same, because this is the first commit this ledger
    // has ever seen. The predictor declines rather than guessing from a history
    // of nothing — a guess from one past case is not a prediction, and scoring
    // it would put noise into the denominator the whole gate rests on.
    expect(row.verdict).toBe("unscored");
    // A request with a browser Origin behind it. An agent's Origin-less shell
    // would read `agent-tolerated` and stay out of the scored denominator.
    expect(row.provenance).toBe("clicked");

    const actual = JSON.parse(String(row.actual)) as Json;
    // Every key, so a new one cannot appear without this line failing. A field
    // added to a categorical payload is exactly how prose gets in.
    expect(Object.keys(actual).sort()).toEqual(["described", "files", "ok", "staged", "titled"]);
    expect(actual.staged).toBe(false);
    expect(actual.files).toBe("1");
    // Booleans, not the strings. That there WAS a title and a body is the
    // habit worth predicting; what they said is the work.
    expect(actual.titled).toBe(true);
    expect(actual.described).toBe(true);
    expect(actual.ok).toBe(true);
  });

  test("and the net recorded the same request, with its real status", () => {
    // `/git/commit` is not inside the `/git/*` switch and carries no
    // `noteAction`, so the stub is the only record that the route was called at
    // all. That is the case the net exists for.
    const stubs = all("understudy_ledger").filter((r) => r.route === "/git/commit");
    expect(stubs.length).toBe(1);
    expect(stubs[0]!.kind).toBe("stub");
    expect(stubs[0]!.status).toBe(200);
  });
});

describe("a gate decision", () => {
  const gateId = "00000000-0000-4000-8000-000000000001";
  let answered: Json;

  beforeAll(async () => {
    // Hold a call, the way the hook does. The promise is nobody's business
    // here; what matters is that it is queued before it is answered.
    void fetch(base + "/gate", {
      method: "POST", headers,
      body: JSON.stringify({
        id: gateId, source_app: "claude", session_id: "s-1", tool_name: "Bash",
        tool_input: { command: `rm -rf ${GATE_CANARY}` }, timeout_ms: 30_000,
      }),
    }).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const r = await fetch(base + "/gate/pending", { headers }).then((x) => x.json() as Promise<Json>);
      if (r.gates.some((g: Json) => g.id === gateId)) break;
      await Bun.sleep(50);
    }
    answered = await post("/gate/decide", { id: gateId, decision: "allow", reason: "it is a scratch directory" }, ORIGIN);
  });

  test("the command line reached the audit log, which is where it is supposed to be", async () => {
    expect(answered.ok, JSON.stringify(answered)).toBe(true);
    const log = await fetch(base + "/actions?limit=20", { headers }).then((r) => r.json() as Promise<Json>);
    const line = log.actions.find((a: Json) => a.action === "/gate/allow");
    expect(line, "the press is not in the action log").toBeTruthy();
    // "who allowed WHAT" is the question #299 opens with, so the log keeps it.
    expect(String(line.target)).toContain(GATE_CANARY);
  });

  test("the understudy kept the tool name and not the command line", () => {
    const rows = decisions("C6");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.subject).toBe(gateId);
    expect(row.provenance).toBe("clicked");
    const actual = JSON.parse(String(row.actual)) as Json;
    expect(Object.keys(actual).sort()).toEqual(["decision", "reasoned", "took", "tool"]);
    expect(actual.decision).toBe("allow");
    // The tool name is categorical — there are a dozen of them and a prediction
    // can be right or wrong about "would it allow a Bash". The summary beside
    // it in the same handler is a command line, and it stays out.
    expect(actual.tool).toBe("Bash");
    expect(actual.took).toBe(true);
    // `reasoned` and not the reason. Whether he bothers to type one is a habit;
    // what he typed is prose, and prose is the thing this feature does not keep.
    expect(actual.reasoned).toBe(true);
  });

  test("and it names the same actor the action log named", async () => {
    /*
     * The actor lives on the stub the net opened for this request, not on the
     * decision row — a decision is filed under a class and a subject rather
     * than under a person, which is deliberate: the scorecard is about how
     * often he and it would agree, and that number must not become a table of
     * who was at the keyboard.
     *
     * So the pairing to check is stub-to-action-log, and it has to hold because
     * both are computed by `actorOf` from the same request. If they could
     * diverge, the two records would answer "who" twice and differently.
     */
    const log = await fetch(base + "/actions?limit=20", { headers }).then((r) => r.json() as Promise<Json>);
    const line = log.actions.find((a: Json) => a.action === "/gate/allow");
    const stubs = all("understudy_ledger").filter((r) => r.route === "/gate/decide");
    expect(stubs.length).toBe(1);
    expect(stubs[0]!.actor).toBe(line.actor);
  });
});

describe("neither canary is anywhere in the understudy's tables", () => {
  test("every column, both writes", () => {
    const tables = ["understudy_ledger", "understudy_snapshots", "understudy_quarantine", "understudy_precedents"];
    let seen = 0;
    for (const table of tables) {
      for (const row of all(table)) {
        seen++;
        for (const [column, value] of Object.entries(row)) {
          const s = String(value ?? "");
          expect(s, `${table}.${column} kept the commit message`).not.toContain(COMMIT_CANARY);
          expect(s, `${table}.${column} kept the command line`).not.toContain(GATE_CANARY);
        }
      }
    }
    // The same guard the net test carries: a negative assertion over an empty
    // set is a statement about nothing.
    expect(seen).toBeGreaterThan(0);
  });
});
