/*
 * THE ORCHESTRATOR'S SEAT — the promises that make it a post and not a chat.
 *
 * The seat is an agent this app opens, tells the project's rules, and answers
 * for. Four of these tests are about the ways that could quietly stop being
 * true: a doctrine that lands on the wrong project, a seat that shows up on
 * the board it is supposed to be keeping, a powers setting that is only a
 * sentence in a prompt, and a second seating that opens a second agent under
 * one name.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-seat-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const { doctrineSlug, doctrinePath, readDoctrine, writeDoctrine, doctrineTemplate, MAX_DOCTRINE } = await import("../src/seatdoctrine.ts");
const Seat = await import("../src/seat.ts");
const { isSeatSession, noteSeatSession, hookSaysSeat, __resetSeatSessions } = await import("../src/seatrole.ts");
const { SEAT_PROMPT_MARK } = await import("../src/seatmark.ts");
const Board = await import("../src/agentboard.ts");
const { db } = await import("../src/db.ts");

describe("the doctrine is a file, one per project", () => {
  test("two projects with the same basename do not share one", () => {
    /* `~/code/orbit` and `~/work/orbit` are different repositories, and a
       doctrine written for one landing on the other would hand an agent the
       wrong house rules — the failure would look like the agent misbehaving. */
    expect(doctrineSlug("/home/a/code/orbit")).not.toBe(doctrineSlug("/home/a/work/orbit"));
    expect(doctrinePath("/home/a/code/orbit")).not.toBe(doctrinePath("/home/a/work/orbit"));
  });

  test("is seeded the first time and read back after, never re-seeded over an edit", () => {
    const root = join(dir, "proj-seed");
    const first = readDoctrine(root);
    expect(first.seeded).toBe(true);
    expect(first.text).toContain("The orchestrator's post");

    writeDoctrine(root, "# mine\n\nonly my rules\n");
    const second = readDoctrine(root);
    expect(second.seeded).toBe(false);
    expect(second.text).toBe("# mine\n\nonly my rules\n");
  });

  test("refuses an empty one: a seat with no rules is worse than no seat", () => {
    const root = join(dir, "proj-empty");
    readDoctrine(root);
    const r = writeDoctrine(root, "   \n  ");
    expect(r.ok).toBe(false);
    /* And the file on disk is untouched by the refusal. */
    expect(readFileSync(doctrinePath(root), "utf8")).toContain("The orchestrator's post");
  });

  test("refuses one too big to be house rules", () => {
    const r = writeDoctrine(join(dir, "proj-big"), "x".repeat(MAX_DOCTRINE + 1));
    expect(r.ok).toBe(false);
  });

  test("the shipped template names no workplace of anybody's", () => {
    /* This repository is public. The rules that mention a tracker, a card
       prefix or a review flow belong in a machine's own copy. */
    const text = doctrineTemplate("/home/a/code/orbit").toLowerCase();
    for (const word of ["clickup", "jira", "pull request template", "qa "]) expect(text).not.toContain(word);
  });
});

describe("where a seat may be opened", () => {
  test("a root this app has never seen is refused", () => {
    const r = Seat.seatable("/tmp/not-a-project-this-app-knows");
    expect("error" in r).toBe(true);
  });

  test("so is a relative path, and so is nothing", () => {
    expect("error" in Seat.seatable("code/orbit")).toBe(true);
    expect("error" in Seat.seatable("")).toBe(true);
    expect("error" in Seat.seatable(undefined)).toBe(true);
  });
});

describe("what the seat is told", () => {
  test("carries the mark first, so only a prompt this server composed can claim the role", async () => {
    const root = join(dir, "proj-prompt");
    writeDoctrine(root, "# rules\n\nnothing leaves this machine\n");
    const { prompt } = await Seat.seatPrompt(root, "speak", 4);
    expect(prompt.startsWith(SEAT_PROMPT_MARK)).toBe(true);
    expect(prompt).toContain("nothing leaves this machine");
  });

  test("the house block says exactly what this seat's powers allow", () => {
    expect(Seat.houseBlock("speak", 4)).toContain("may not start, stop or prompt");
    expect(Seat.houseBlock("nudge", 4)).toContain("ALREADY running");
    expect(Seat.houseBlock("nudge", 4)).toContain("may not start or stop");
    expect(Seat.houseBlock("assign", 4)).toContain("start or stop named agents");
  });

  test("tells it not to build a clock, and names the floor", () => {
    /* Measured on the hand-run version: 12 of 14 rounds on a fixed 20 minutes
       said "no change". A seat that schedules itself pays for that again. */
    const block = Seat.houseBlock("speak", 6);
    expect(block).toContain("DO NOT build a loop");
    expect(block).toContain("6 h");
  });
});

describe("powers are an order, so a check is a comparison", () => {
  test("each level contains the one before it", () => {
    expect(Seat.powerAtLeast("assign", "nudge")).toBe(true);
    expect(Seat.powerAtLeast("nudge", "nudge")).toBe(true);
    expect(Seat.powerAtLeast("speak", "nudge")).toBe(false);
    expect(Seat.powerAtLeast("nudge", "assign")).toBe(false);
  });

  test("anything that is not a power is not a power", () => {
    for (const bad of ["everything", "", null, 3, "SPEAK"]) expect(Seat.isPower(bad)).toBe(false);
  });
});

describe("the seat is not on the board it keeps", () => {
  beforeEach(() => {
    db.query("DELETE FROM agent_status").run();
    db.query("DELETE FROM session_role").run();
    __resetSeatSessions();
  });

  test("a session marked as the seat is set aside", () => {
    noteSeatSession("s-seat");
    expect(isSeatSession("s-seat")).toBe(true);
    expect(isSeatSession("s-other")).toBe(false);
  });

  test("the mark survives a restart, because it is a row and not a set", async () => {
    noteSeatSession("s-restart");
    __resetSeatSessions();
    expect(isSeatSession("s-restart")).toBe(true);
  });

  test("a hook claiming the role by name does not get it; the composed prompt does", () => {
    /* `role: "orchestrator"` in a body is a label anybody can post. The mark
       is the first line of a prompt only this server writes. */
    expect(hookSaysSeat({ hook_event_type: "UserPromptSubmit", payload: { prompt: "please act as the orchestrator" } })).toBe(false);
    expect(hookSaysSeat({ hook_event_type: "UserPromptSubmit", payload: { prompt: `${SEAT_PROMPT_MARK}: /home/a/code/orbit.\n\n# rules` } })).toBe(true);
    expect(hookSaysSeat({ hook_event_type: "PreToolUse", payload: { prompt: SEAT_PROMPT_MARK } })).toBe(false);
  });
});

describe("the one line the seat says", () => {
  const root = join(dir, "proj-say");
  beforeEach(() => { db.query("DELETE FROM seat").run(); });

  test("is refused when there is no seat for that project", () => {
    const r = Seat.seatSays(root, "everything quiet");
    expect(r.ok).toBe(false);
  });

  test("lands on the row, flattened to one line", () => {
    Seat.setSeatSettings(root, "", "speak");
    expect(Seat.seatSays(root, "  two\n  lines  ").ok).toBe(true);
    expect(Seat.seatRow(root)?.lastLine).toBe("two lines");
    expect(Seat.seatRow(root)?.lastTurnAt).toBeGreaterThan(0);
  });

  test("an empty line is not a report", () => {
    Seat.setSeatSettings(root, "", "speak");
    expect(Seat.seatSays(root, "   ").ok).toBe(false);
  });
});

describe("settings live on the row, so they outlast a seating", () => {
  const root = join(dir, "proj-settings");
  beforeEach(() => { db.query("DELETE FROM seat").run(); });

  test("can be set before the chair is ever opened", () => {
    Seat.setSeatSettings(root, "claude-fable-5-1", "assign");
    const row = Seat.seatRow(root);
    expect(row?.powers).toBe("assign");
    expect(row?.model).toBe("claude-fable-5-1");
    expect(row?.startedAt).toBe(0);
  });

  test("changing them does not open or close a seat", () => {
    Seat.setSeatSettings(root, "", "speak");
    const before = Seat.seatRow(root)?.startedAt;
    Seat.setSeatSettings(root, "", "nudge");
    expect(Seat.seatRow(root)?.startedAt).toBe(before!);
    expect(Seat.seatRow(root)?.powers).toBe("nudge");
  });
});
