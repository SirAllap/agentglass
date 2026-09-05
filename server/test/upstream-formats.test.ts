/*
 * Golden fixtures for the four formats this app reads but does not own.
 *
 * Tested against Claude Code 2.1.237. The transcript record set and the hook
 * payloads in test/fixtures/upstream/ were derived from a real session on that
 * version — the key sets, the content-block shapes and the `usage` object were
 * read off a live transcript — and then rewritten with invented values, so no
 * real path, project or session id is in the repository.
 *
 * WHY THIS FILE EXISTS
 *
 * Twelve server modules parse surfaces nobody here controls: the transcript
 * JSONL under the user's Claude projects directory, the JSON a hook receives on
 * stdin, and the OTLP attribute names an agent's telemetry exporter emits. None
 * of those is a published contract with a version number. When one drifts, this
 * app does not crash — it keeps working and the numbers quietly go wrong. That
 * is the whole failure mode: a renamed token attribute means the cost column
 * reads zero and looks like "agentglass cannot price my provider"; a renamed
 * transcript field means a tool call loses its name and the diff list goes
 * empty. Both were shipped bugs before this file existed.
 *
 * WHAT A FAILURE HERE MEANS — read this at 2am
 *
 * These tests do not exercise agentglass logic in isolation. They push a frozen
 * upstream document through the real production parser and compare the whole
 * derived shape at once, so a red line here says: *the fixture and the parser
 * disagree*. There are exactly two ways that happens.
 *
 *   1. You changed a parser and did not mean to change its output. The diff
 *      names the field. Fix the parser; the fixture is the older, verified
 *      answer.
 *
 *   2. Nobody touched the parser — a dependency bump or a new Claude Code
 *      brought a new shape, and you are updating the fixture to match. Then the
 *      fixture is the stale side, and updating it is a deliberate act: capture
 *      the NEW upstream document, put it in fixtures/upstream/, update the
 *      version line at the top of this comment, and check whether the parser
 *      still needs the old shape as well (it usually does — machines run old
 *      CLIs). Never edit only the expected values to make the red go away: that
 *      is how a rename gets absorbed silently, which is the exact failure this
 *      file is here to make loud.
 *
 * The fixtures are literal upstream documents with ONE exception, and it is
 * marked in the file: the transcript's `cwd` is the placeholder `__CWD__`,
 * because the scanner resolves that directory on the filesystem and refuses a
 * transcript from outside the open workspace. Everything else is byte-for-byte
 * what the parser is handed in production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "upstream");
const HOOKS = join(FIXTURES, "hooks");

const dir = mkdtempSync(join(tmpdir(), "agx-upstream-"));
// Sweep this fixture tree, never the developer's ~/.claude/projects. Read per
// sweep by the scanner, so it holds however the module got imported.
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
// Only claim a database if nothing has yet: `bun test` shares one process and
// db.ts opens its file at import, so an earlier file may already own it.
// Sharing is fine — every assertion below is keyed by session id.
process.env.AGENTGLASS_DB ||= join(dir, "upstream.db");

const SESSION = "cafe0001-0000-4000-8000-000000000001";
const HOOK_SESSION = "cafe0002-0000-4000-8000-000000000002";
const PANE = "%99";

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let ingest: typeof import("../src/ingest.ts");
let otlp: typeof import("../src/otlp.ts");
let panewt: typeof import("../src/panewt.ts");
/** A real directory the scanner will accept. If an earlier test file pinned a
 *  workspace scope, anything outside it is skipped before it is parsed. */
let CWD = join(dir, "notekeeper");

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  ingest = await import("../src/ingest.ts");
  otlp = await import("../src/otlp.ts");
  panewt = await import("../src/panewt.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-upstream-fixture");
  mkdirSync(CWD, { recursive: true });

  // The fixture, verbatim, with only the placeholder directory filled in.
  // JSON.stringify does the escaping so a Windows path's backslashes cannot
  // turn a valid record into a parse error.
  const raw = readFileSync(join(FIXTURES, "claude-code-transcript.jsonl"), "utf8");
  const projects = join(dir, "projects", "-srv-notekeeper");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), raw.replaceAll("__CWD__", JSON.stringify(CWD).slice(1, -1)));
});

// `bun test` shares one process and the database may be one an earlier file
// opened, so these rows land in it. Take them back out: other files assert on
// what is ABSENT, and in CI the file order differs from the local one.
afterAll(() => {
  if (!db) return;
  for (const table of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${table} WHERE session_id IN (?, ?)`, [SESSION, HOOK_SESSION]); } catch { /* no such column */ }
  }
  try { db.db.run("DELETE FROM pane_agent WHERE pane_id = ?", [PANE]); } catch { /* table may not exist */ }
});

// ---------------------------------------------------------------------------
// 1. The transcript JSONL under ~/.claude/projects/<slug>/<session>.jsonl
// ---------------------------------------------------------------------------
//
// Read by transcripts.ts on a 3s sweep. This is the surface with the most
// fields in it and the least documentation: `isSidechain`, `gitBranch`,
// `agentId`, the repeated `message.id`, the `custom-title` and `ai-title`
// records, and the fact that a tool_result's content is sometimes a string and
// sometimes a list of text blocks. All of those are load-bearing here.
describe("Claude Code transcript JSONL", () => {
  interface Row { hook_event_type: string; tool_name: string | null; model_name: string | null; is_error: number; error_text: string | null; payload: string }
  let rows: Row[] = [];

  beforeAll(async () => {
    await scan.scanOnce(null);
    rows = db.db
      .query<Row, [string]>(
        "SELECT hook_event_type, tool_name, model_name, is_error, error_text, payload FROM events WHERE session_id = ? ORDER BY id",
      )
      .all(SESSION);
  });

  test("the whole record set maps to the events the rest of the app reads", () => {
    // One comparison rather than a dozen: a rename upstream shows up as a diff
    // that names the field, instead of as whichever assertion happened to run
    // first.
    const derived = rows.map((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        type: r.hook_event_type,
        tool: r.tool_name,
        model: r.model_name,
        error: r.is_error ? r.error_text : null,
        agent_type: p.agent_type ?? null,
        agent_id: p.agent_id ?? null,
        git_branch: p.git_branch ?? null,
      };
    });
    expect(derived).toEqual([
      // A typed message. The `isMeta` line right after it is the CLI's injected
      // preamble and must NOT become a prompt.
      { type: "UserPromptSubmit", tool: null, model: null, error: null, agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
      // One assistant API response split across two transcript lines, one per
      // content block — two calls, one reply.
      { type: "PreToolUse", tool: "Read", model: "claude-opus-4-8", error: null, agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
      { type: "PreToolUse", tool: "Bash", model: "claude-opus-4-8", error: null, agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
      // The results, paired back to their calls by tool_use_id.
      { type: "PostToolUse", tool: "Read", model: null, error: null, agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
      { type: "PostToolUse", tool: "Bash", model: null, error: "pytest: command not found", agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
      // A subagent turn: its own transcript line, the PARENT's session id, and
      // `isSidechain` is the only thing that says so.
      { type: "Stop", tool: null, model: "claude-haiku-4-8", error: null, agent_type: "subagent", agent_id: "agent_0000000001", git_branch: "fix/cart-rounding" },
      // A text-only assistant turn ends the turn. The `thinking` block carries
      // no text and must not become one.
      { type: "Stop", tool: null, model: "claude-opus-4-8", error: null, agent_type: null, agent_id: null, git_branch: "fix/cart-rounding" },
    ]);
  });

  test("a tool call's input travels to the result, which is what the diff list reads", () => {
    const post = rows.filter((r) => r.hook_event_type === "PostToolUse").map((r) => JSON.parse(r.payload));
    expect(post[0].tool_input).toEqual({ file_path: "/srv/notekeeper/cart.py" });
    expect(post[0].tool_response).toEqual({ content: "def subtotal(items):\n    return sum(round(i.price, 2) for i in items)\n", is_error: false });
    // A tool_result whose content is a LIST of text blocks, not a string.
    expect(post[1].tool_response).toEqual({ content: "pytest: command not found", is_error: true });
  });

  test("the session is placed by the record's own cwd and sessionId, not by the file name", () => {
    // The directory encoding in the path is lossy (a dash in a folder name is
    // indistinguishable from a separator) and a subagent transcript is named
    // after the agent while reporting the parent session, so both answers are
    // read out of the records. Rename either field upstream and the project
    // path comes back empty and the session is filed under a truncated id —
    // which is invisible until somebody wonders where their project went.
    const f = db.db
      .query<{ session_id: string; project_path: string }, [string]>(
        "SELECT session_id, project_path FROM transcript_files WHERE session_id = ?",
      )
      .get(SESSION);
    expect(f?.session_id).toBe(SESSION);
    expect(f?.project_path).not.toBe("");
    expect(CWD.startsWith(f!.project_path)).toBe(true);
    // And it rides on every event, because that is what the folder filter and
    // the project column read.
    for (const r of rows) expect(JSON.parse(r.payload).project_path).toBe(f!.project_path);
  });

  test("one API response's tokens are counted once, not once per content block", () => {
    // `message.id` is the only thing that says two lines are one reply. Lose it
    // and this session's tokens come out multiplied by the block count —
    // measured at 2.5x on real transcripts.
    const s = db.db
      .query<{ input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }, [string]>(
        "SELECT input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens FROM sessions WHERE session_id = ?",
      )
      .get(SESSION);
    expect(s).toEqual({ input_tokens: 31, output_tokens: 218, cache_creation_tokens: 2000, cache_read_tokens: 62000 });
  });

  test("the session's names come from the title records, which are not events", () => {
    // `/rename` appends a `custom-title` line; the CLI's own guess is an
    // `ai-title` line. Neither is a message, so nothing else in the parser
    // would notice if they were renamed.
    const s = db.db
      .query<{ custom_title: string | null; ai_title: string | null }, [string]>(
        "SELECT custom_title, ai_title FROM sessions WHERE session_id = ?",
      )
      .get(SESSION);
    expect(s).toEqual({ custom_title: "cart rounding", ai_title: "cart rounding bug" });
  });

  test("a transcript attached to a hook prices per line, at that line's own model", () => {
    // The other consumer of the same document: send_event.py --add-chat reads
    // the whole JSONL and posts it as `chat`, which ingest.ts sums. Only a
    // machine whose scanner does not own the session takes this path, but the
    // shapes it depends on — `message.usage`, `message.model` — are the same
    // ones, and this is where a rename would go unnoticed longest.
    const chat = readFileSync(join(FIXTURES, "claude-code-transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const n = ingest.normalize({
      source_app: "notekeeper",
      session_id: "cafe0005-0000-4000-8000-000000000005",
      hook_event_type: "Stop",
      payload: {},
      chat,
    });
    expect(n.usage_is_cumulative).toBe(true);
    // Every usage object in the file, summed. Note this deliberately does NOT
    // dedupe by `message.id` the way the scanner does — the sum is read as a
    // running session total that the DB diffs against what it already has.
    expect(n.usage).toEqual({ input_tokens: 42, output_tokens: 338, cache_creation_tokens: 4000, cache_read_tokens: 92000 });
    // Priced per line at that line's own model: the haiku turn is not billed at
    // the opus rate just because opus spoke last.
    expect(n.cost_cumulative).toBe(ingest.sumTranscriptCost(chat, null));
  });
});

// ---------------------------------------------------------------------------
// 2. The hook payload contract — the JSON Claude Code writes to a hook's stdin
// ---------------------------------------------------------------------------
//
// One fixture per event agentglass installs (hooksetup.ts:EVENTS), pushed
// through the shipped forwarder and then through the server's normalizer, so
// both halves of the seam are covered: what send_event.py lifts out of the
// payload, and what normalize() makes of the body it posts.
describe("Claude Code hook payloads", () => {
  const files = readdirSync(HOOKS).filter((f) => f.endsWith(".json")).sort();

  /** Run one fixture through the real forwarder and return the body it posted. */
  async function forward(file: string): Promise<Record<string, unknown>> {
    let resolveBody!: (b: Record<string, unknown>) => void;
    const received = Promise.race([
      new Promise<Record<string, unknown>>((r) => { resolveBody = r; }),
      Bun.sleep(5_000).then(() => { throw new Error(`the hook forwarder never posted ${file}`); }),
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) { resolveBody(await req.json() as Record<string, unknown>); return new Response("ok"); },
    });
    try {
      const proc = Bun.spawn([
        python!,
        join(import.meta.dir, "..", "..", "hooks", "send_event.py"),
        "--server", `http://127.0.0.1:${server.port}`,
        "--source-app", "notekeeper",
      ], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // TMUX_PANE is how the forwarder answers "which pane is this agent in" —
        // nothing in the payload says, and nothing on the server can work it out.
        // AGENTGLASS_INTERNAL is blanked because the developer running this may
        // have it set, and it makes the forwarder exit without sending.
        env: { ...process.env, TMUX_PANE: PANE, AGENTGLASS_INTERNAL: "", AGENTGLASS_TOKEN: "" },
      });
      proc.stdin.write(readFileSync(join(HOOKS, file), "utf8"));
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      return await received;
    } finally {
      server.stop(true);
    }
  }

  test("every event agentglass installs a hook for has a fixture", () => {
    // hooksetup.ts:EVENTS is the list the installer writes into settings.json.
    // An event added there with no fixture is an unparsed shape.
    expect(files.map((f) => f.replace(/(-failed)?\.json$/, ""))).toEqual([
      "Notification",
      "PostToolUse",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
  });

  test.if(!!python)("the forwarder lifts the same four fields out of every event", async () => {
    // `hook_event_name`, `session_id`, `cwd` and `transcript_path` are the ones
    // read by something other than the event row itself: the event type drives
    // the whole vocabulary, and the last two are what panewt.ts needs to say
    // which tmux pane an agent is sitting in.
    const seen: Record<string, unknown>[] = [];
    for (const file of files) {
      const body = await forward(file);
      const payload = body.payload as Record<string, unknown>;
      seen.push({
        file,
        hook_event_type: body.hook_event_type,
        session_id: body.session_id,
        tmux_pane: body.tmux_pane,
        cwd: payload.cwd,
        has_transcript_path: typeof payload.transcript_path === "string" && payload.transcript_path.length > 0,
      });
    }
    expect(seen).toEqual(files.map((file) => ({
      file,
      // Taken from the payload's own `hook_event_name` — no --event-type flag
      // was passed, which is how a hook installed by another tool arrives.
      hook_event_type: file.replace(/(-failed)?\.json$/, ""),
      session_id: HOOK_SESSION,
      tmux_pane: PANE,
      cwd: "/srv/notekeeper",
      has_transcript_path: true,
    })));
  });

  test.if(!!python)("a tool call and its result normalize into the pair the latency chart needs", async () => {
    const pre = ingest.normalize(await forward("PreToolUse.json") as never);
    const post = ingest.normalize(await forward("PostToolUse.json") as never);
    expect([pre, post].map((n) => ({ type: n.hook_event_type, tool: n.tool_name, id: n.tool_use_id, error: n.is_error }))).toEqual([
      { type: "PreToolUse", tool: "Bash", id: "toolu_0000000000000011", error: 0 },
      { type: "PostToolUse", tool: "Bash", id: "toolu_0000000000000011", error: 0 },
    ]);
  });

  test.if(!!python)("a failed Bash call is read out of tool_response, where the failure actually lives", async () => {
    // There is no PostToolUseFailure hook — it never fires. A shell failure is
    // a zero-exit PostToolUse whose tool_response carries the stderr, which is
    // why detectError has to look inside it.
    const n = ingest.normalize(await forward("PostToolUse-failed.json") as never);
    expect({ error: n.is_error, text: n.error_text }).toEqual({
      error: 1,
      text: "bash: pytest: command not found\n",
    });
  });

  test.if(!!python)("a subagent's stop carries the agent it was", async () => {
    const n = ingest.normalize(await forward("SubagentStop.json") as never);
    expect({ id: n.agent_id, type: n.agent_type }).toEqual({ id: "agent_0000000001", type: "code-reviewer" });
  });

  test.if(!!python)("a prompt survives the trip as the prompt", async () => {
    const body = await forward("UserPromptSubmit.json");
    expect(ingest.normalize(body as never).payload.prompt).toBe("why is the cart total a cent low");
  });

  test.if(!!python)("the pane an agent is in is recoverable from the hook body alone", async () => {
    // panewt.ts reads `tmux_pane` off the body and `transcript_path` + `cwd` out
    // of the payload. Rename any of the three upstream and the pane mapping
    // stops working — silently, because an agent that never runs another tool
    // simply has no row.
    const body = await forward("PreToolUse.json");
    expect(panewt.notePaneFromHook(body as never)).toBe(true);
    expect(panewt.paneForSession(HOOK_SESSION)).toBe(PANE);
  });
});

// ---------------------------------------------------------------------------
// 3. OTLP — the attribute names an exporter puts on a GenAI span or log record
// ---------------------------------------------------------------------------
//
// This is the surface that has already drifted in production: the token
// attribute list stopped matching what OpenInference instrumentors emit, and
// nothing broke — the span was still recognised as GenAI, the session landed,
// the model resolved, and only the numbers were missing. It read as "agentglass
// cannot price my provider" rather than as one missing key. Hence a fixture
// that carries BOTH spellings.
describe("OTLP GenAI attributes", () => {
  const traces = () => JSON.parse(readFileSync(join(FIXTURES, "otlp-traces.json"), "utf8"));
  const logs = () => JSON.parse(readFileSync(join(FIXTURES, "otlp-logs.json"), "utf8"));

  test("a trace export maps to turns and to a paired tool call", () => {
    const derived = otlp.otlpTracesToEvents(traces()).map((e) => ({
      type: e.hook_event_type,
      at: e.timestamp,
      app: e.source_app,
      session: e.session_id,
      model: e.model_name,
      payload: e.payload,
    }));
    expect(derived).toEqual([
      {
        // Official gen_ai.* conventions. `input_tokens` there is the TOTAL
        // prompt including cache, so the buckets are what is left after the
        // cached halves come out — 32011 - 30000 - 2000.
        type: "Turn complete", at: 1787130002000, app: "notekeeper-agent",
        session: "cafe0003-0000-4000-8000-000000000003", model: "claude-opus-4-8",
        payload: {
          usage: { input_tokens: 11, output_tokens: 120, cache_read_tokens: 30000, cache_creation_tokens: 2000 },
          gen_ai_system: "anthropic", operation: "chat", span_name: "chat claude-opus-4-8",
        },
      },
      {
        // OpenInference, the spelling Arize Phoenix and its instrumentors use.
        // This is the one that silently stopped matching: no gen_ai.* key at
        // all, and `prompt_details.cache_read` is a subset of `prompt`.
        type: "Turn complete", at: 1787130004000, app: "notekeeper-agent",
        session: "cafe0003-0000-4000-8000-000000000003", model: "example-model-1",
        payload: {
          usage: { input_tokens: 300, output_tokens: 90, cache_read_tokens: 1200, cache_creation_tokens: 0 },
          gen_ai_system: undefined, operation: undefined, span_name: "ChatCompletion",
        },
      },
      // One tool span becomes two events sharing the span's call id, so the
      // existing pre→post pairing yields a real latency.
      {
        type: "PreToolUse", at: 1787130005000, app: "notekeeper-agent",
        session: "cafe0003-0000-4000-8000-000000000003", model: undefined,
        payload: { tool_name: "search_notes", tool_use_id: "call_0000000000000001" },
      },
      {
        type: "PostToolUse", at: 1787130006500, app: "notekeeper-agent",
        session: "cafe0003-0000-4000-8000-000000000003", model: undefined,
        payload: { tool_name: "search_notes", tool_use_id: "call_0000000000000001", is_error: true, error: "index unavailable" },
      },
    ]);
  });

  test("a log export maps records to turns, tool events and telemetry", () => {
    const derived = otlp.otlpLogsToEvents(logs()).map((e) => ({
      type: e.hook_event_type,
      at: e.timestamp,
      session: e.session_id,
      payload: e.payload,
    }));
    expect(derived).toEqual([
      {
        // Codex's own attribute spelling. `input_token_count` includes the
        // cached tokens, same as the official convention.
        type: "Turn complete", at: 1787130000000, session: "cafe0004-0000-4000-8000-000000000004",
        payload: {
          usage: { input_tokens: 300, output_tokens: 90, cache_read_tokens: 1200, cache_creation_tokens: 0 },
          gen_ai_system: undefined, event: "codex.api_request",
        },
      },
      {
        type: "PreToolUse", at: 1787130001000, session: "cafe0004-0000-4000-8000-000000000004",
        payload: { tool_name: "shell", tool_use_id: "call_0000000000000002" },
      },
      {
        type: "PostToolUse", at: 1787130002500, session: "cafe0004-0000-4000-8000-000000000004",
        payload: { tool_name: "shell", tool_use_id: "call_0000000000000002", is_error: true, error: "bash: pytest: command not found" },
      },
      {
        // A genuine hold. This one is allowed to say "an agent wants you".
        type: "Notification", at: 1787130003000, session: "cafe0004-0000-4000-8000-000000000004",
        payload: { message: "approve running shell?", event: "codex.notification.approval_required" },
      },
      {
        // And this one is not. A rollout flush is telemetry; if it ever comes
        // back as Notification again it lights up the fleet card, the desktop
        // notification and the webhook for nothing.
        type: "Telemetry", at: 1787130004000, session: "cafe0004-0000-4000-8000-000000000004",
        payload: { message: "flushed 3 rollout records", event: "codex.rollout.flush" },
      },
    ]);
  });

  test("the OTLP events survive normalize with their tokens intact", () => {
    // The mapper's output is not stored — it goes through the same normalizer
    // the hooks do, and that is where a `usage` key it does not recognise would
    // be dropped. Worth asserting on the far side of the seam, not just here.
    const turn = otlp.otlpTracesToEvents(traces()).find((e) => e.hook_event_type === "Turn complete")!;
    const n = ingest.normalize(turn);
    expect(n.usage).toEqual({ input_tokens: 11, output_tokens: 120, cache_creation_tokens: 2000, cache_read_tokens: 30000 });
    // Per-call usage, not a running total: the DB must not diff it against the
    // session's previous number.
    expect(n.usage_is_cumulative).toBe(false);
  });
});
