/*
 * Which worktree the agent in a pane is working in.
 *
 * The cases here are the ones that made the previous answer — scanning the
 * terminal for a folder name — wrong on a real machine, kept as tests so the
 * new one cannot regress into them:
 *
 *   * the worktree is named in a tool INPUT, in a `git -C` that the CLI draws
 *     folded as "Ran 3 shell commands";
 *   * a single `git worktree list` names every worktree at once, and it does it
 *     in a tool RESULT — a reader that counted those answers at random;
 *   * the newest mention wins, because a long session moves between worktrees;
 *   * a pane id outlives the agent that was in it, and tmux hands it out again.
 *
 * The transcript is fed as text so all of that is testable without a CLI
 * writing one, which is the same reason paneloc.ts splits its parser out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dirsFromTranscript, notePaneAgent, notePaneFromHook, paneAgentNote, paneDirs, readTail, resetTailCache,
} from "../src/panewt.ts";

const WT = "/home/dev/code/orbit-WEB-1042";
const REPO = "/home/dev/code/orbit";

/** One transcript line, in the shape the CLI writes. */
const toolUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

const toolResult = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } });

describe("dirsFromTranscript", () => {
  test("finds the worktree in a shell command the screen folds away", () => {
    const t = [
      toolUse("Bash", { command: `git -C ${WT} status --short` }),
    ].join("\n");
    expect(dirsFromTranscript(t)).toContain(WT);
  });

  test("finds it in a file path", () => {
    const t = toolUse("Edit", { file_path: `${WT}/vr/serializers.py` });
    expect(dirsFromTranscript(t)[0]).toBe(`${WT}/vr/serializers.py`);
  });

  test("newest first — a session that moved worktrees answers with the last one", () => {
    const t = [
      toolUse("Bash", { command: `git -C ${REPO}-WEB-900 log` }),
      toolUse("Bash", { command: `git -C ${WT} log` }),
    ].join("\n");
    expect(dirsFromTranscript(t)[0]).toBe(WT);
  });

  test("ignores tool results, where `git worktree list` names all of them at once", () => {
    const every = Array.from({ length: 20 }, (_, i) => `${REPO}-WEB-${i} abc123 [WEB-${i}]`).join("\n");
    const t = [
      toolUse("Bash", { command: `git -C ${WT} status` }),
      toolResult(every),
    ].join("\n");
    // The result is newer than the command and mentions twenty other
    // worktrees. None of them may win.
    expect(dirsFromTranscript(t)[0]).toBe(WT);
    expect(dirsFromTranscript(t).some((d) => d.endsWith("-WEB-7"))).toBe(false);
  });

  test("survives the half line a tail always starts with, and non-JSON", () => {
    const t = [
      `{"type":"assistant","message":{"content":[{"type":"tool_use","inp`,
      "not json at all",
      "",
      toolUse("Bash", { command: `cd ${WT} && bun test` }),
    ].join("\n");
    expect(dirsFromTranscript(t)).toEqual([WT]);
  });

  test("stops at the cap rather than reading a whole session", () => {
    const t = Array.from({ length: 50 }, (_, i) => toolUse("Read", { file_path: `${WT}/f${i}.ts` })).join("\n");
    expect(dirsFromTranscript(t, 5)).toHaveLength(5);
  });

  test("a path stops at the quote or the operator that follows it", () => {
    const t = toolUse("Bash", { command: `cat '${WT}/a.py' && rm ${WT}/b.py` });
    expect(dirsFromTranscript(t)).toEqual([`${WT}/a.py`, `${WT}/b.py`]);
  });
});

describe("readTail", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agx-panewt-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("reads the end of a file, not the start", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "old\n".repeat(1000) + "newest\n");
    expect(readTail(p, 32).endsWith("newest\n")).toBe(true);
  });

  test("a transcript that is not there yet is empty, not a throw", () => {
    expect(readTail(join(dir, "nope.jsonl"))).toBe("");
  });
});

describe("the pane note", () => {
  const PANE = "%9910";

  test("a hook body without a pane, a transcript or a cwd is not stored", () => {
    expect(notePaneFromHook({ session_id: "s", payload: { cwd: REPO } })).toBe(false);
    expect(notePaneFromHook({ session_id: "s", tmux_pane: PANE, payload: { cwd: REPO } })).toBe(false);
    expect(notePaneFromHook({ session_id: "s", tmux_pane: PANE, payload: { transcript_path: "/t.jsonl" } })).toBe(false);
  });

  test("a pane id that is not tmux's spelling is refused", () => {
    expect(notePaneAgent({ pane: "%3; rm -rf /", sessionId: "s", transcriptPath: "/t.jsonl", cwd: REPO })).toBe(false);
    expect(paneAgentNote("%3; rm -rf /")).toBeNull();
  });

  test("one row per pane — the agent in it now replaces the one before", () => {
    notePaneAgent({ pane: PANE, sessionId: "old", transcriptPath: "/old.jsonl", cwd: REPO });
    notePaneAgent({ pane: PANE, sessionId: "new", transcriptPath: "/new.jsonl", cwd: REPO });
    expect(paneAgentNote(PANE)?.session_id).toBe("new");
    expect(paneAgentNote(PANE)?.transcript_path).toBe("/new.jsonl");
  });
});

describe("paneDirs", () => {
  let dir = "", transcript = "";
  const PANE = "%9911";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agx-panedirs-"));
    transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, toolUse("Bash", { command: `git -C ${WT} diff` }) + "\n");
    resetTailCache();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("the agent's own directory comes first, and the transcript fills in behind it", () => {
    notePaneAgent({ pane: PANE, sessionId: "s", transcriptPath: transcript, cwd: REPO });
    const { dirs } = paneDirs(PANE, 1, () => [REPO]);
    // The parent repo is where every agent in a fleet stands; the worktree it
    // is actually working in only exists in what it asked for.
    expect(dirs[0]).toBe(REPO);
    expect(dirs).toContain(WT);
  });

  test("an agent started inside the worktree needs no transcript at all", () => {
    const { dirs } = paneDirs("%9912", 1, () => [WT]);
    expect(dirs).toEqual([WT]);
  });

  test("a note from an agent that is no longer in this pane is not believed", () => {
    notePaneAgent({ pane: PANE, sessionId: "s", transcriptPath: transcript, cwd: "/home/dev/code/something-else" });
    // tmux handed %9911 to a different project. The old session's worktree must
    // not come back with it.
    const { dirs } = paneDirs(PANE, 1, () => [REPO]);
    expect(dirs).toEqual([REPO]);
  });

  test("no agent, no note, no answer — and no throw", () => {
    expect(paneDirs("%9913", 1, () => []).dirs).toEqual([]);
  });
});
