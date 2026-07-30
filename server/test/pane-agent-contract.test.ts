/*
 * What a pane agent has to provide, checked against the one that exists.
 *
 * The engine renders a conversation from the transcript a CLI writes, never
 * from the screen — that is why a pane chat reads as a chat instead of a wall
 * of terminal output. The cost was that four of Claude Code's own decisions
 * were spread through a 600-line file: where the binary is, the transcript
 * path, the launch flags, and the line that ends a turn.
 *
 * They are one interface now, and this is what holds it honest. The important
 * assertions are not that Claude Code satisfies it — it is the file the
 * interface was extracted from, so of course it does — but that the *properties
 * the engine relies on* are stated somewhere a second implementation will be
 * measured against.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeCode, claudeHome, projectSlug } from "../src/agents/claudecode.ts";
import { transcriptFor } from "../src/chatpane.ts";

const src = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");

/**
 * The file with its prose taken out.
 *
 * The rules below are about what the engine *builds*, and this codebase's
 * comments explain the things they no longer do — a paragraph about why
 * `--session-id` must not be reused belongs next to the code that decides it,
 * and would otherwise fail a check about hard-coded flags for being an
 * explanation rather than a coupling.
 */
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const spec = (over: Partial<Parameters<typeof claudeCode.argv>[0]> = {}) => ({
  sessionId: "6b191fd3-f71e-5010-863d-d32334eaf400",
  cwd: "/home/x/code/app",
  model: "claude-opus-5",
  effort: "",
  mode: "default",
  fresh: true,
  ...over,
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENTGLASS_CLAUDE_HOME;
  process.env.AGENTGLASS_CLAUDE_HOME = "/tmp/agx-fixture-home";
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENTGLASS_CLAUDE_HOME;
  else process.env.AGENTGLASS_CLAUDE_HOME = saved;
});

describe("the end of a turn", () => {
  /**
   * The load-bearing one, and the reason this engine works at all.
   *
   * The transcript is appended to as the turn runs, so "has it finished" cannot
   * be answered by the file being quiet — a tool call that takes four minutes
   * looks exactly like a turn that ended. Only a marker the agent itself wrote
   * is an answer, and that is the property a second agent has to bring.
   */
  test("is an explicit marker, not the absence of one", () => {
    expect(claudeCode.isTurnEnd({ type: "system", subtype: "turn_duration" })).toBe(true);
  });

  test("and nothing that merely looks like the end is mistaken for it", () => {
    for (const entry of [
      { type: "system" },                                    // some other system line
      { type: "system", subtype: "compact_boundary" },       // a real one that is not the end
      { type: "assistant", message: { content: [] } },       // an empty reply mid-turn
      { type: "user" },
      { type: "result" },                                    // the `-p` engine's shape, not this one
      {},
    ]) {
      expect(claudeCode.isTurnEnd(entry), JSON.stringify(entry)).toBe(false);
    }
  });

  test("and the engine asks the agent rather than matching a string itself", () => {
    // The coupling this whole change exists to remove. A `turn_duration` left
    // in chatpane.ts would mean a second agent silently never finishes a turn.
    const engine = code("chatpane.ts");
    expect(engine).not.toContain("turn_duration");
    expect(engine).toContain("agent.isTurnEnd(o)");
  });
});

describe("starting and resuming", () => {
  test("a session that has never run is started, one that has is resumed", () => {
    // Reusing `--session-id` on an existing session is a hard error — "Session
    // ID is already in use" — so getting this backwards does not degrade, it
    // fails the turn outright.
    expect(claudeCode.argv(spec({ fresh: true }))).toContain("--session-id");
    expect(claudeCode.argv(spec({ fresh: true }))).not.toContain("--resume");
    expect(claudeCode.argv(spec({ fresh: false }))).toContain("--resume");
    expect(claudeCode.argv(spec({ fresh: false }))).not.toContain("--session-id");
  });

  test("the effort flag is omitted rather than sent empty", () => {
    // Empty means "leave the CLI's own setting alone", and `--effort ""` is not
    // that — it is a value the CLI has to reject or misread.
    expect(claudeCode.argv(spec({ effort: "" }))).not.toContain("--effort");
    expect(claudeCode.argv(spec({ effort: "high" }))).toContain("high");
  });

  test("bypass is its own flag, not a permission mode", () => {
    const bypass = claudeCode.argv(spec({ mode: "bypassPermissions" }));
    expect(bypass).toContain("--dangerously-skip-permissions");
    expect(bypass).not.toContain("--permission-mode");
    const normal = claudeCode.argv(spec({ mode: "acceptEdits" }));
    expect(normal).toContain("--permission-mode");
    expect(normal).toContain("acceptEdits");
    expect(normal).not.toContain("--dangerously-skip-permissions");
  });

  test("and the engine builds no argv of its own", () => {
    const engine = code("chatpane.ts");
    expect(engine).toContain("agent.argv({");
    for (const flag of ["--resume", "--session-id", "--permission-mode", "--dangerously-skip-permissions"]) {
      expect(engine, `${flag} is still hard-coded in the engine`).not.toContain(flag);
    }
  });
});

describe("where the turn is read from", () => {
  test("is computable before the session has written anything", () => {
    // Required, not convenient: a brand-new session has no file until it
    // answers, and the turn has to know where to watch before it sends.
    const p = claudeCode.transcriptFor("/home/x/code/app", "abc");
    expect(p).toBe("/tmp/agx-fixture-home/projects/-home-x-code-app/abc.jsonl");
  });

  test("the slug is the one Claude Code actually derives, not a guess", () => {
    // Every non-alphanumeric becomes `-`, so a separator and a leading dot each
    // contribute one. Verified against a real session rather than inferred.
    expect(projectSlug("/home/x/code/app/.claude/wt")).toBe("-home-x-code-app--claude-wt");
    expect(projectSlug("/a_b/c.d")).toBe("-a-b-c-d");
  });

  test("and the engine goes through the agent to find it", () => {
    expect(transcriptFor("/home/x/code/app", "abc")).toBe(claudeCode.transcriptFor("/home/x/code/app", "abc"));
    expect(code("chatpane.ts")).not.toContain('"projects"');
  });

  test("the home honours the CLI's own knob, and the test override", () => {
    // AGENTGLASS_CLAUDE_HOME exists so a suite points at a fixture instead of
    // the developer's real history.
    expect(claudeHome()).toBe("/tmp/agx-fixture-home");
    delete process.env.AGENTGLASS_CLAUDE_HOME;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/agx-cli-knob";
    expect(claudeHome()).toBe("/tmp/agx-cli-knob");
    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe("what reaches the browser", () => {
  test("is the conversation, and not the rest of the transcript", () => {
    // A transcript carries file-history snapshots, attachment records and the
    // CLI's own title guess. Forwarding those would have the browser parsing
    // shapes nobody wrote a case for.
    expect(claudeCode.forwards("assistant")).toBe(true);
    expect(claudeCode.forwards("user")).toBe(true);
    for (const t of ["system", "summary", "file-history-snapshot", "attachment", "result", ""]) {
      expect(claudeCode.forwards(t), t).toBe(false);
    }
  });
});

describe("the boundary the engine will not cross", () => {
  test("nothing in the contract asks an agent to be read off the screen", () => {
    // The engine screen-reads for exactly one thing — deciding the TUI has
    // finished drawing its input box — and that boundary is the reason the rest
    // is structured data. An agent that could only be scraped loses tool
    // structure, thinking and usage, and breaks on the next redraw.
    const contract = src("paneagent.ts");
    const iface = contract.slice(contract.indexOf("export interface PaneAgent"));
    for (const scrape of ["capture", "screen", "scrape"]) {
      expect(iface.toLowerCase(), `the contract mentions ${scrape}`).not.toContain(scrape);
    }
  });

  test("and the reason it will not is written down, not just absent", () => {
    // An absence with no reason attached reads as an oversight, and gets
    // helpfully filled in by the next person.
    // The comment as prose: leaders stripped, then whitespace collapsed. A
    // regex over the raw file asserts where the lines happen to break, and the
    // ` * ` at the start of each one is not part of the sentence.
    const contract = src("paneagent.ts")
      .split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join(" ")
      .replace(/\s+/g, " ");
    expect(contract).toMatch(/reading the screen/i);
    expect(contract).toMatch(/decline rather than accommodate/);
    expect(contract).toMatch(/loses tool structure, thinking and usage/);
  });
});
