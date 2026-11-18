/*
 * THE END OF AN INTERACTIVE TURN, from the CLI's own transcript.
 *
 * A worker runs the real Claude Code TUI, so it never exits when a turn ends:
 * the one fact that ends it is the `turn_duration` line the CLI writes, and the
 * answer is the assistant text after the last thing said to the model. These
 * are the cases a card, a plan and the seat's notice are all built on, so they
 * are asserted without a window: a transcript on disk, and the two files the
 * wrapper would have written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerIn, isTurnEndLine, leaveTuiResult, transcriptSize, turnEndedIn, watchTuiTurn } from "../src/agents/tuiturn.ts";
import type { RunFiles } from "../src/agents/headless.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-tui-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const said = (text: string): string => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const answered = (text: string): string => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = (): string => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
const toolUse = (): string => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
const thinking = (): string => line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] } });
const ended = (): string => line({ type: "system", subtype: "turn_duration", durationMs: 1200 });

/** A turn's run folder, as `prepareRun` leaves it. */
function run(name: string): RunFiles {
  const d = join(dir, name);
  mkdirSync(join(d, "part"), { recursive: true });
  return { dir: d, input: join(d, "in"), prompt: join(d, "prompt"), out: join(d, "out"), err: join(d, "err"), rc: join(d, "rc"), view: join(d, "view.py") };
}

const until = async <T,>(f: () => T | undefined | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v as T; if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(20); }
};

describe("reading a transcript", () => {
  test("the marker is the CLI's own, and nothing else is", () => {
    expect(isTurnEndLine(ended().trim())).toBe(true);
    expect(isTurnEndLine(line({ type: "system", subtype: "init" }).trim())).toBe(false);
    expect(isTurnEndLine(line({ type: "result", subtype: "success" }).trim())).toBe(false);
    expect(isTurnEndLine("not json")).toBe(false);
  });

  test("the answer is the assistant text, not the thinking, the tool calls or a tool's output", () => {
    const text = [said("fix the export"), thinking(), toolUse(), toolResult(), answered("done: the retry keeps the last page"), ended()].join("");
    expect(answerIn(text.split("\n"))).toBe("done: the retry keeps the last page");
  });

  test("a tool result does not wipe the answer; the seat speaking again does", () => {
    expect(answerIn([said("one"), answered("first answer"), toolResult()].join("").split("\n"))).toBe("first answer");
    // The second turn's prompt: its answer is the one that counts.
    expect(answerIn([said("one"), answered("first answer"), said("and now?"), answered("second answer")].join("").split("\n"))).toBe("second answer");
  });

  test("no marker, no end: a turn still running has not ended", () => {
    expect(turnEndedIn([said("go"), answered("still working")].join(""))).toBeNull();
    expect(turnEndedIn([said("go"), answered("done"), ended()].join(""))).toEqual({ answer: "done" });
  });
});

describe("watching one turn", () => {
  test("the marker writes the answer and the status the wrapper would have written", async () => {
    const files = run("turn-1");
    const transcript = join(dir, "turn-1.jsonl");
    writeFileSync(transcript, "");
    const stop = watchTuiTurn({ files, transcript, pollMs: 20 });
    try {
      appendFileSync(transcript, said("find the retry"));
      await Bun.sleep(60);
      expect(existsSync(files.rc)).toBe(false);
      appendFileSync(transcript, answered("the retry is in the export") + ended());
      await until(() => existsSync(files.rc));
      expect(readFileSync(files.rc, "utf8").trim()).toBe("0");
      expect(readFileSync(files.out, "utf8")).toBe("the retry is in the export");
    } finally { stop(); }
  });

  test("a resumed session's earlier turns do not end this one", async () => {
    const files = run("turn-2");
    const transcript = join(dir, "turn-2.jsonl");
    writeFileSync(transcript, said("yesterday") + answered("yesterday's answer") + ended());
    const stop = watchTuiTurn({ files, transcript, from: transcriptSize(transcript), pollMs: 20 });
    try {
      await Bun.sleep(120);
      expect(existsSync(files.rc)).toBe(false);
      appendFileSync(transcript, said("today") + answered("today's answer") + ended());
      await until(() => existsSync(files.rc));
      expect(readFileSync(files.out, "utf8")).toBe("today's answer");
    } finally { stop(); }
  });

  test("half a line is not a marker: the write that lands mid-line waits for the rest", async () => {
    const files = run("turn-3");
    const transcript = join(dir, "turn-3.jsonl");
    writeFileSync(transcript, "");
    const stop = watchTuiTurn({ files, transcript, pollMs: 20 });
    try {
      const whole = answered("the last page") + ended();
      appendFileSync(transcript, whole.slice(0, whole.length - 8));
      await Bun.sleep(120);
      expect(existsSync(files.rc)).toBe(false);
      appendFileSync(transcript, whole.slice(whole.length - 8));
      await until(() => existsSync(files.rc));
      expect(readFileSync(files.out, "utf8")).toBe("the last page");
    } finally { stop(); }
  });

  test("the status is left whole, so the folder's watch never sees an empty one", () => {
    const files = run("turn-4");
    leaveTuiResult(files, "done");
    expect(readFileSync(files.rc, "utf8")).toBe("0\n");
    expect(existsSync(join(files.dir, "part", "rc"))).toBe(false);
  });
});

describe("a turn stopped on a dialog nobody can answer", () => {
  /* What the CLI draws when it wants permission, and what a working turn draws:
     the second says "esc to interrupt", which is deliberately not a prompt. */
  const DIALOG = " Bash command\n   bun test\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n Esc to cancel\n";
  const WORKING = "✻ Thinking…\n  esc to interrupt\n";

  test("is ended with an error instead of sitting until the ceiling", async () => {
    const files = run("stuck-1");
    const transcript = join(dir, "stuck-1.jsonl");
    writeFileSync(transcript, said("run the tests") + answered("running them"));
    // The argv cannot be asked (headless.ts `dontAsk`); this is the guard for
    // what does not obey it — a trust dialog in a fresh directory, say. Without
    // it the turn sat until the limit, was killed with 124 and lost its plan.
    const stop = watchTuiTurn({ files, transcript, pollMs: 10, stallMs: 20, screen: () => DIALOG });
    try {
      await until(() => existsSync(files.rc));
      expect(readFileSync(files.rc, "utf8").trim()).toBe("1");
      expect(readFileSync(files.err, "utf8")).toContain("prompt nobody can answer");
      expect(existsSync(files.out)).toBe(false);
    } finally { stop(); }
  });

  test("is only the screen's word: a still transcript on a working pane is not a dialog", async () => {
    const files = run("stuck-2");
    const transcript = join(dir, "stuck-2.jsonl");
    writeFileSync(transcript, said("run the tests"));
    // A tool call writes its transcript line when it returns, so stillness alone
    // means nothing; only the dialog does.
    const stop = watchTuiTurn({ files, transcript, pollMs: 10, stallMs: 20, screen: () => WORKING });
    try {
      await Bun.sleep(120);
      expect(existsSync(files.rc)).toBe(false);
    } finally { stop(); }
  });

  test("a working pane is asked once per stall window, not on every tick", async () => {
    /* A `bun test` or `make` writes nothing for minutes. Asking the pane on
       every tick once the transcript had been still cost a `tmux capture-pane`
       per second for the rest of the call. */
    const files = run("stuck-4");
    const transcript = join(dir, "stuck-4.jsonl");
    writeFileSync(transcript, said("run the tests"));
    let asked = 0;
    const stop = watchTuiTurn({ files, transcript, pollMs: 10, stallMs: 40, screen: () => { asked++; return WORKING; } });
    try {
      await Bun.sleep(400);
      expect(existsSync(files.rc)).toBe(false);
      // ~10 windows in 400ms; a per-tick ask is ~40.
      expect(asked).toBeLessThanOrEqual(14);
    } finally { stop(); }
  });

  test("does not end a turn that wrote its marker while the screen was stuck", async () => {
    const files = run("stuck-3");
    const transcript = join(dir, "stuck-3.jsonl");
    writeFileSync(transcript, said("go") + answered("the answer") + ended());
    const stop = watchTuiTurn({ files, transcript, pollMs: 10, stallMs: 20, screen: () => DIALOG });
    try {
      await until(() => existsSync(files.rc));
      expect(readFileSync(files.rc, "utf8").trim()).toBe("0");
      expect(readFileSync(files.out, "utf8")).toBe("the answer");
    } finally { stop(); }
  });
});
