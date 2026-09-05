// One run, more than one vendor.
//
// "Shows agents from more than one vendor" is the sentence this product is sold
// on, and until this file it was half true: the chat side dispatched three CLIs
// and the terminal side had one binary written into it. A leg could already
// NAME a vendor — `startRun` took a roster id and resolved it — and then the
// command line was built by the Claude path anyway, so `codex` was started with
// `--dangerously-skip-permissions`. That is not a degraded leg. An unrecognised
// flag makes a CLI print usage and exit, so the tmux window opens, flashes and
// closes, and the run reports one arm where two were asked for.
//
// So the first half of this file starts a run with two different agents in it
// and reads the argv each one actually got — against real binaries whose
// `--help` says what they take, because the whole mechanism is a capability
// probe and a fake that cannot be probed would prove nothing.
//
// The second half is the bill. A comparison between vendors that reports one
// number is not a comparison, and `sessions.provider` cannot produce two: it is
// latched first-non-null-wins, which db.ts says where it adds the per-event
// column. The split is asked of `events`, where every row carries the provider
// of the model that produced it.
//
// The third is the one that has to keep being true: nothing about any of this
// changes what happens when nobody names an agent.
import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-run-agents-")));
const REPO = join(dir, "repo");
const BIN = join(dir, "bin");

process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "agents.db");
process.env.AGENTGLASS_ROOT = dir;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/**
 * A binary that answers `--help` with the flags it claims to take.
 *
 * Real files rather than a stubbed probe: `supportsFlag` decides by spawning
 * the thing and reading what comes back, and a test that replaced that with a
 * lookup would be asserting the table instead of the mechanism. These cost a
 * fork each and are the difference between "the code says codex takes this
 * flag" and "the binary said so".
 */
function fakeCli(name: string, help: string): string {
  const path = join(BIN, name);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  cat <<'H'\n${help}\nH\nfi\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

let runs: typeof import("../src/runs.ts");
let launch: typeof import("../src/agents/launch.ts");
let ticket: typeof import("../src/agentticket.ts");
let db: typeof import("../src/db.ts");
let gitwork: typeof import("../src/gitwork.ts");

/** Every window the run opened, by the branch it was opened for. */
const opened = new Map<string, string[]>();

let CLAUDE = "";
let CODEX = "";
let GEMINI = "";
let OLD_CODEX = "";

beforeAll(async () => {
  process.env.AGENTGLASS_ROOT = dir;
  mkdirSync(BIN, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "t");
  writeFileSync(join(REPO, "README"), "x\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "root");

  CLAUDE = fakeCli("claude", "  -n, --name <name>          name this session\n  --dangerously-skip-permissions");
  CODEX = fakeCli("codex", "      --dangerously-bypass-approvals-and-sandbox\n          skip all confirmation prompts");
  GEMINI = fakeCli("gemini", "  -y, --yolo                 auto-accept all actions\n  -i, --prompt-interactive   run in interactive mode with a prompt");
  // The same vendor, a version back, which is the case the probe exists for:
  // its help says nothing about the flag, so the flag must not be passed.
  OLD_CODEX = fakeCli("codex-old", "      --sandbox <MODE>       sandbox policy");

  db = await import("../src/db.ts");
  gitwork = await import("../src/gitwork.ts");
  launch = await import("../src/agents/launch.ts");
  ticket = await import("../src/agentticket.ts");
  runs = await import("../src/runs.ts");
  runs.__clearRuns();
});

/** The four calls a leg makes, with the two that need a machine faked and the
 *  argv left entirely real — that is the thing under test. */
const deps = (bins: Record<string, string>) => ({
  cut: (root: string, path: string, branch: string, from?: string) => gitwork.addWorktree(root, path, branch, true, from),
  open: async (_root: string, name: string, argv: string[]) => {
    opened.set(name, argv);
    return { paneId: `%${opened.size}`, windowId: `@${opened.size}` };
  },
  bin: (agent: string) => bins[agent] ?? null,
  exists: existsSync,
});

describe("a run with two vendors in it", () => {
  test("gives each leg its own vendor's command line", async () => {
    const r = await runs.startRun(
      REPO,
      "which of these is right?",
      [{ agent: "claude-code", yolo: true }, { agent: "codex", yolo: true }],
      deps({ "claude-code": CLAUDE, codex: CODEX }),
    );
    expect(r.ok).toBe(true);
    expect(r.run!.legs).toHaveLength(2);

    const [claude, codex] = r.run!.legs;
    // The branch carries the agent, which is what makes the two windows legible
    // in a tmux list — and what this test reads them back by.
    const claudeArgv = opened.get(claude!.branch)!;
    const codexArgv = opened.get(codex!.branch)!;

    expect(claudeArgv[0]).toBe(CLAUDE);
    expect(claudeArgv).toContain("--dangerously-skip-permissions");
    expect(codexArgv[0]).toBe(CODEX);
    expect(codexArgv).toContain("--dangerously-bypass-approvals-and-sandbox");

    // The bug, pinned from the other side: Claude's spelling must never reach
    // the other binary. This is the assertion that fails on the code as it
    // stood, and it fails as a window that opens and closes rather than as an
    // error anybody sees.
    expect(codexArgv).not.toContain("--dangerously-skip-permissions");
    expect(claudeArgv).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    // Both still carry the same question, last and as one element.
    expect(claudeArgv.at(-1)).toBe("which of these is right?");
    expect(codexArgv.at(-1)).toBe("which of these is right?");
  });

  test("asks the binary rather than trusting the table", () => {
    const req = { prompt: "compare these", yolo: true, title: "" };
    // A codex old enough not to have the flag: dropped, not passed hopefully.
    // Passing it would cost the window, which is the whole reason this is a
    // probe and not a constant.
    expect(launch.launchArgv("codex", OLD_CODEX, req)).toEqual([OLD_CODEX, "compare these"]);
    expect(launch.launchArgv("codex", CODEX, req))
      .toEqual([CODEX, "--dangerously-bypass-approvals-and-sandbox", "compare these"]);
  });

  test("hands the prompt over the way each CLI takes it", () => {
    const req = { prompt: "compare these", yolo: false, title: "" };
    // Gemini answers a bare positional and exits, so its prompt goes through
    // the flag that keeps the session up — when the binary says it has one.
    expect(launch.launchArgv("gemini", GEMINI, req)).toEqual([GEMINI, "-i", "compare these"]);
    // And when it does not say so, the prompt still goes: positionally, which
    // is what every path in this server did before the table existed. A flag
    // that cannot be proven degrades to the shipped behaviour and not to a leg
    // that opened in the right checkout and never asked anything.
    expect(launch.launchArgv("gemini", OLD_CODEX, req)).toEqual([OLD_CODEX, "compare these"]);
  });

  test("opens a plain shell when the named agent is not on this machine", async () => {
    const r = await runs.startRun(REPO, "no codex here", [{ agent: "codex" }], deps({}));
    expect(r.ok).toBe(true);
    // No binary, no argv — every caller reads that as "a shell in the right
    // tree", which is most of what was asked for. And the leg records that it
    // got no agent, so the run cannot later claim a comparison it did not make.
    expect(opened.get(r.run!.legs[0]!.branch)).toEqual([]);
    expect(r.run!.legs[0]!.agent).toBe("");
  });
});

describe("the bill, split by the vendor that charged for it", () => {
  /** One turn, filed under the directory it ran in and the model that answered.
   *  `reported_cost_usd` rather than a token count so the numbers below are the
   *  ones this test wrote, not whatever the price table says today. */
  const turn = (session: string, cwd: string, i: number, model: string | null, cost: number) => ({
    source_app: "repo",
    session_id: session,
    hook_event_type: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: `${session}-${i}`,
    agent_id: null,
    agent_type: null,
    model_name: model,
    is_error: 0,
    error_text: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    usage_is_cumulative: false,
    reported_cost_usd: cost,
    summary: "",
    timestamp: Date.now() - (100 - i) * 1000,
    payload: { project_path: REPO, cwd, tool_input: { command: "bun test" } },
    chat: null,
  });

  let run: import("../src/runs.ts").Run;
  let ANT = "";
  let OAI = "";

  beforeAll(async () => {
    const r = await runs.startRun(
      REPO,
      "two vendors, one question",
      [{ agent: "claude-code" }, { agent: "codex" }],
      deps({ "claude-code": CLAUDE, codex: CODEX }),
    );
    ANT = r.run!.legs[0]!.worktree;
    OAI = r.run!.legs[1]!.worktree;
    for (let i = 0; i < 3; i++) db.insertEvent(turn("sess-ant", ANT, i, "claude-opus-4-8", 0.1) as any);
    for (let i = 0; i < 2; i++) db.insertEvent(turn("sess-oai", OAI, i, "gpt-5.6-sol", 0.2) as any);
    // An event whose model never resolved, in the first leg. Stored with a NULL
    // provider, and it has to land in a bucket rather than disappear.
    db.insertEvent(turn("sess-ant", ANT, 9, null, 0.05) as any);
    run = runs.runById(r.run!.id)!;
  });

  test("reports one line per vendor across the run", () => {
    const bills = runs.runSpend(runs.runActivity(run));
    expect(bills.map((b) => b.provider)).toEqual(["OpenAI", "Anthropic", "unknown"]);
    expect(bills[0]!.costUsd).toBeCloseTo(0.4, 6);
    expect(bills[1]!.costUsd).toBeCloseTo(0.3, 6);
    expect(bills[2]!.costUsd).toBeCloseTo(0.05, 6);
  });

  test("attributes each leg's spend to the vendor that ran there", () => {
    const legs = runs.runActivity(run);
    const ant = legs.find((l) => l.worktree === ANT)!;
    const oai = legs.find((l) => l.worktree === OAI)!;
    expect(ant.providers.map((p) => p.provider)).toEqual(["Anthropic", "unknown"]);
    expect(oai.providers.map((p) => p.provider)).toEqual(["OpenAI"]);
    // OpenAI's money must not appear under Anthropic, which is exactly what one
    // latched `sessions.provider` per leg would have produced the moment a leg
    // ran two models.
    expect(ant.providers.some((p) => p.provider === "OpenAI")).toBe(false);
  });

  test("adds up to what the leg spent", () => {
    // A bill whose lines do not sum to the total is worse than no split at all:
    // it is two numbers on one pane disagreeing, with nothing saying which is
    // right.
    for (const leg of runs.runActivity(run)) {
      const sum = leg.providers.reduce((n, p) => n + p.costUsd, 0);
      expect(sum).toBeCloseTo(leg.costUsd, 6);
    }
  });

  test("a leg that has produced nothing reports no bill rather than vanishing", async () => {
    const r = await runs.startRun(REPO, "nothing yet", [{ agent: "claude-code" }], deps({ "claude-code": CLAUDE }));
    const legs = runs.runActivity(runs.runById(r.run!.id)!);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.providers).toEqual([]);
    expect(runs.runSpend(legs)).toEqual([]);
  });
});

describe("the default path, when nobody names an agent", () => {
  test("is the command line agentticket.ts already built", () => {
    const req = { prompt: "review this", yolo: true, title: "card title" };
    const canName = launch.supportsFlag(CLAUDE, "--name");
    // Not "looks the same" — the same array, from the same builder. The whole
    // claim of this change is that a second vendor was added beside the shipped
    // path rather than on top of it.
    expect(launch.launchArgv("", CLAUDE, req)).toEqual(ticket.agentArgv(CLAUDE, req, canName));
    expect(launch.launchArgv("claude-code", CLAUDE, req)).toEqual(ticket.agentArgv(CLAUDE, req, canName));
    expect(launch.launchArgv("", CLAUDE, req))
      .toEqual([CLAUDE, "--name", "card title", "--dangerously-skip-permissions", "review this"]);
  });

  test("keeps the empty prompt out of the argv", () => {
    // An empty string is one positional argument that happens to be empty, and
    // the CLI read it as the thing it had been asked to do — measured from the
    // bench, and the reason agentticket.ts spells this out.
    expect(launch.launchArgv("", CLAUDE, { prompt: "", yolo: false, title: "" })).toEqual([CLAUDE]);
    expect(launch.launchArgv("codex", CODEX, { prompt: "", yolo: false, title: "" })).toEqual([CODEX]);
  });

  test("opens nothing rather than a bare binary when there is none", () => {
    for (const id of ["", "claude-code", "codex", "gemini", "antigravity"]) {
      expect(launch.launchArgv(id, null, { prompt: "x", yolo: true, title: "" })).toEqual([]);
    }
  });

  test("never puts one vendor's flag on another vendor's binary", () => {
    // A roster entry with no spelling written down yet still gets its checkout
    // and its question — but not a permission flag borrowed from somebody else,
    // which is the failure the table exists to prevent.
    const req = { prompt: "compare these", yolo: true, title: "" };
    expect(launch.launchArgv("someone-new", CODEX, req)).toEqual([CODEX, "compare these"]);
  });
});
