/*
 * What the form for a move's fields decides, without a renderer: when the
 * button may be pressed, which fields are still owed, what each filled field
 * will do, and the sentence under the form in every state. The rule about what
 * "filled in" means is the server's (shared/jiraMoveFields.ts); these tests
 * hold the form to it.
 */
import { describe, expect, test } from "bun:test";
import { askHint, footerOf, formView, toSend } from "../src/lib/jiraMoveForm.ts";
import type { JiraMoveField } from "../../shared/jiraMoveFields.ts";

const resolution: JiraMoveField = { key: "resolution", name: "Resolution", required: true, kind: "option", choices: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }] };
const comment: JiraMoveField = { key: "comment", name: "Comment", required: false, kind: "comment" };
const reviewer: JiraMoveField = { key: "reviewer", name: "Reviewer", required: true, kind: "unsupported", type: "userpicker" };
const sprint: JiraMoveField = { key: "sprint", name: "Sprint", required: false, kind: "unsupported", type: "sprint" };

describe("when the button may be pressed", () => {
  test("a required field left empty keeps it off and the sentence names the field", () => {
    const v = formView([resolution, comment], {}, { phase: "idle" });
    expect(v.canSubmit).toBe(false);
    expect(v.missing).toEqual(["resolution"]);
    expect(v.hint).toBe("Resolution is required.");
  });

  test("spaces are not an answer, and a comment alone does not stand in for the required field", () => {
    expect(formView([resolution, comment], { resolution: "  ", comment: "words" }, { phase: "idle" }).canSubmit).toBe(false);
  });

  test("filled in: on, with what will happen said before the press", () => {
    const v = formView([resolution, comment], { resolution: "10001", comment: "Not needed" }, { phase: "idle" });
    expect(v.canSubmit).toBe(true);
    expect(v.effects).toEqual(["Sets Resolution to Won't Do", "Adds your comment"]);
    expect(v.hint).toBe("Nothing in Jira has changed yet.");
  });

  test("a choice the site never offered is a problem on that field, not a press", () => {
    const v = formView([resolution], { resolution: "42" }, { phase: "idle" });
    expect(v.canSubmit).toBe(false);
    expect(v.problems).toEqual({ resolution: "Resolution is not one of the choices" });
  });

  test("while it runs, and once it is done, the button cannot be pressed again; after a failure it can", () => {
    const filled = { resolution: "10000" };
    expect(formView([resolution], filled, { phase: "running" }).canSubmit).toBe(false);
    expect(formView([resolution], filled, { phase: "done" }).canSubmit).toBe(false);
    expect(formView([resolution], filled, { phase: "failed" }).canSubmit).toBe(true);
  });
});

describe("a field this cannot fill is said, never dropped", () => {
  test("a required one blocks the whole move, with the way out", () => {
    const v = formView([resolution, reviewer], { resolution: "10000" }, { phase: "idle" });
    expect(v.canSubmit).toBe(false);
    expect(v.blocked).toBe("Reviewer cannot be filled in here yet. Make this move in Jira.");
    expect(v.hint).toBe(v.blocked as string);
  });

  test("an optional one is named once and does not stop the move", () => {
    const v = formView([resolution, sprint], { resolution: "10000" }, { phase: "idle" });
    expect(v.canSubmit).toBe(true);
    expect(v.notOffered).toBe("Not offered here: Sprint.");
  });
});

describe("what is sent, and the sentence in each state", () => {
  test("blanks and fields this cannot fill are left out", () => {
    expect(toSend([resolution, comment, sprint], { resolution: "10000", comment: " ", sprint: "3" })).toEqual({ resolution: "10000" });
  });

  test("what a filled field did is said in the past once the move is done", () => {
    const done = formView([resolution, comment], { resolution: "10000", comment: "ok" }, { phase: "done" });
    expect(done.effects).toEqual(["Set Resolution to Done", "Added your comment"]);
  });

  test("each state says what is true", () => {
    const o = { hint: "Nothing in Jira has changed yet.", key: "ORBIT-1042" };
    expect(footerOf({ ...o, phase: "idle" })).toEqual({ text: o.hint, tone: "plain" });
    expect(footerOf({ ...o, phase: "idle", blocked: true }).tone).toBe("bad");
    expect(footerOf({ ...o, phase: "running" })).toEqual({ text: "Writing to Jira…", tone: "plain" });
    expect(footerOf({ ...o, phase: "failed", error: "Resolution is not one of the choices" })).toEqual({ text: "Resolution is not one of the choices", tone: "bad" });
    expect(footerOf({ ...o, phase: "failed" }).text).toContain("Nothing was changed");
    expect(footerOf({ ...o, phase: "done", now: "Done" })).toEqual({ text: "Done. ORBIT-1042 is now Done.", tone: "good" });
  });
});

describe("the list says what a move asks for, short", () => {
  test("one field by its name, several as a count, and the keys only when the screen is unknown", () => {
    expect(askHint([resolution, comment], ["resolution"])).toBe("asks for Resolution");
    expect(askHint([resolution, { ...comment, required: true }], ["resolution", "comment"])).toBe("asks for 2 fields");
    expect(askHint(undefined, ["resolution"])).toBe("asks for resolution");
  });
});

describe("the picker opens the form and does not refuse", () => {
  const src = Bun.file(new URL("../src/components/TrackerStatusPick.tsx", import.meta.url));
  test("a move that needs a field is not disabled in the list, and the form is what sends it", async () => {
    const code = (await src.text()).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/disabled:\s*true,\s*hint:/);
    expect(code).toContain("form.show(");
    // The list is read on first open: until it lands a row says so, in the place the moves will be.
    expect(code).toContain("Reading what this card can do");
    expect(code).toContain("tracker.setStatus(task, opt, values)");
  });
});
