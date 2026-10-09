/*
 * The decisions behind the card's Status row, pulled out of the screen.
 *
 * Who may change a status, when the confirm button is live, what a 409 turns
 * into, and what "Undo" sends back. There is no renderer here, so the screen
 * only draws what these answer.
 */
import { describe, expect, test } from "bun:test";
import {
  commentAccess, conflictDialog, moveLabel, moveOutcome, statusAccess, statusChoices, undoTarget, WRITES_OFF, READ_ONLY_PHONE,
} from "../src/model/cardStatus.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const task = (over: Partial<ProviderTask>): ProviderTask => ({
  id: "t1", title: "Add retry to sync", url: "", status: "In Review", statusKind: "open", priority: null,
  due: null, updated: 1_000_000, tags: [], list: "Orbit Sprint", assignees: [], ...over,
});

describe("who can change a status", () => {
  test("only a full phone, on a computer that lets ClickUp be written to", () => {
    expect(statusAccess("full", true)).toEqual({ can: true, why: null });
  });

  test("a phone paired for less is told why, and the sheet does not open", () => {
    for (const scope of ["read", "answer", null, undefined] as const) {
      expect(statusAccess(scope, true)).toEqual({ can: false, why: READ_ONLY_PHONE });
    }
  });

  test("a full phone with writes switched off says that instead", () => {
    expect(statusAccess("full", false)).toEqual({ can: false, why: WRITES_OFF });
  });

  test("not yet known is neither allowed nor an accusation", () => {
    expect(statusAccess("full", null)).toEqual({ can: false, why: null });
    expect(statusAccess("full", undefined)).toEqual({ can: false, why: null });
  });

  test("the scope wins when both are wrong: pairing again is the first fix", () => {
    expect(statusAccess("read", false).why).toBe(READ_ONLY_PHONE);
  });
});

describe("the confirm button", () => {
  test("names the choice, and only when it differs from where the card is", () => {
    expect(moveLabel("In Review", "In Progress")).toEqual({ label: "Move to In Progress", enabled: true });
    expect(moveLabel("In Review", "In Review")).toEqual({ label: "Pick another status", enabled: false });
    expect(moveLabel("In Review", null)).toEqual({ label: "Pick another status", enabled: false });
  });

  test("case and padding are not a different status", () => {
    expect(moveLabel("In Review", " in review ").enabled).toBe(false);
  });
});

describe("the choices", () => {
  const list = [
    { status: "Backlog", color: "#888888", type: "open" },
    { status: "In Review", color: "#6644cc", type: "custom" },
    { status: "Blocked", color: "#cc3322", type: "custom" },
    { status: "", type: "custom" },
  ];

  test("every status of the list in its own order, the current one tagged, nameless ones dropped", () => {
    expect(statusChoices(list, "in review").map((c) => [c.status, c.current])).toEqual([
      ["Backlog", false], ["In Review", true], ["Blocked", false],
    ]);
  });

  test("the colour travels with the status", () => {
    expect(statusChoices(list, "Backlog")[2]!.color).toBe("#cc3322");
  });
});

describe("what the write answered", () => {
  test("a moved card comes back with its task", () => {
    const t = task({ status: "Blocked" });
    expect(moveOutcome({ ok: true, value: { ok: true, task: t } })).toEqual({ kind: "moved", task: t });
  });

  test("the server's 409 is a conflict, not a sentence to read", () => {
    expect(moveOutcome({ ok: false, error: "Somebody changed this card", status: 409 })).toEqual({ kind: "conflict" });
  });

  test("a pre-read that failed reaches the screen as the sentence, never as a conflict", () => {
    // The server answers 400 with the honest sentence; only a 409 is somebody else.
    const said = "Nothing was changed — could not check the card first. ClickUp answered 500";
    expect(moveOutcome({ ok: false, error: said, status: 400 })).toEqual({ kind: "failed", text: said });
  });

  test("a conflict flag inside a 200 is one too", () => {
    expect(moveOutcome({ ok: true, value: { ok: false, conflict: true } })).toEqual({ kind: "conflict" });
  });

  test("a refusal keeps the board's own words, and a dead connection its own", () => {
    expect(moveOutcome({ ok: true, value: { ok: false, error: "ClickUp: Status not found" } }))
      .toEqual({ kind: "failed", text: "ClickUp: Status not found" });
    expect(moveOutcome({ ok: true, value: { ok: false } })).toEqual({ kind: "failed", text: "The board refused that." });
    expect(moveOutcome({ ok: false, error: "No connection", status: undefined })).toEqual({ kind: "failed", text: "No connection" });
    expect(moveOutcome({ ok: false, error: "Writing to ClickUp is switched off", status: 400 }))
      .toEqual({ kind: "failed", text: "Writing to ClickUp is switched off" });
  });
});

describe("the conflict dialog", () => {
  const now = 10_000_000;
  const minutesAgo = (m: number): number => now - m * 60_000;

  test("says what the card is now and when, and offers to keep it or overwrite it", () => {
    const d = conflictDialog({
      theirs: task({ status: "Blocked", updated: minutesAgo(2) }), opened: "In Review", wanted: "In Progress", now,
    });
    expect(d.text).toBe("Somebody moved this to Blocked 2 min ago. Moving it now would overwrite that.");
    expect(d.keep).toBe("Keep Blocked");
    expect(d.overwrite).toBe("Move to In Progress anyway");
  });

  test("a change that left the status alone is called a change, not a move", () => {
    const d = conflictDialog({
      theirs: task({ status: "In Review", updated: minutesAgo(90) }), opened: "In Review", wanted: "Done", now,
    });
    expect(d.text).toBe("Somebody changed this card 2 h ago. Moving it now is still possible.");
    expect(d.keep).toBe("Keep In Review");
    expect(d.overwrite).toBe("Move to Done anyway");
  });

  test("somebody already made the very move: nothing to overwrite", () => {
    const d = conflictDialog({
      theirs: task({ status: "Done", updated: minutesAgo(0) }), opened: "In Review", wanted: "done", now,
    });
    expect(d.text).toBe("Somebody already moved this to Done just now.");
    expect(d.overwrite).toBeNull();
  });
});

describe("undo", () => {
  test("goes back to where it was, while the card is still where the move put it", () => {
    expect(undoTarget({ from: "In Review", to: "In Progress" }, "In Progress")).toBe("In Review");
  });

  test("is gone once somebody moved the card again: it would overwrite them", () => {
    expect(undoTarget({ from: "In Review", to: "In Progress" }, "Blocked")).toBeNull();
  });

  test("is gone when there is nothing to go back to", () => {
    expect(undoTarget(null, "In Progress")).toBeNull();
    expect(undoTarget({ from: "In Progress", to: "in progress" }, "In Progress")).toBeNull();
  });
});

describe("who can comment", () => {
  test("the same switch as the other writes: writes off on the computer says so", () => {
    expect(commentAccess("full", true)).toEqual({ can: true, why: null });
    expect(commentAccess("full", false)).toEqual({ can: false, why: WRITES_OFF });
    expect(commentAccess("full", null)).toEqual({ can: false, why: null });
  });

  test("the card screen disables its Comment button with it, not with the scope alone", async () => {
    const src = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();
    expect(src).toMatch(/<Btn label="Comment" disabled=\{!mayComment\.can\}/);
  });
});
