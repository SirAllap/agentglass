import { describe, expect, it } from "bun:test";
import { confirmVariant, enterAction, tagPlan, pickerBody, dialogKeyScope } from "../src/lib/gitDialog.ts";

describe("confirmVariant", () => {
  it("a destructive question starts on Cancel and Enter does not confirm it", () => {
    const v = confirmVariant({ danger: true, irreversible: true, command: "git stash drop stash@{0}" });
    expect(v).toEqual({ tone: "danger", focus: "cancel", enterConfirms: false, showCommand: true, cannotUndo: true });
  });
  it("a danger that git can undo does not claim it cannot be undone", () => {
    expect(confirmVariant({ danger: true }).cannotUndo).toBe(false);
  });
  it("an ordinary question starts on the primary action and Enter confirms", () => {
    expect(confirmVariant({})).toMatchObject({ tone: "primary", focus: "confirm", enterConfirms: true });
  });
  it("a prompt starts in its field", () => {
    expect(confirmVariant({ hasInput: true })).toMatchObject({ focus: "input", enterConfirms: true });
  });
  it("an agent-prepared question is careful too", () => {
    expect(confirmVariant({ preparedBy: "fixer" })).toMatchObject({ focus: "cancel", enterConfirms: false });
  });
});

describe("enterAction", () => {
  const base = { enterConfirms: true, focusOnCancel: false, confirmDisabled: false };
  it("confirms by default", () => expect(enterAction(base)).toBe("confirm"));
  it("does nothing on Cancel", () => expect(enterAction({ ...base, focusOnCancel: true })).toBe("none"));
  it("does nothing while the primary action is off", () => expect(enterAction({ ...base, confirmDisabled: true })).toBe("none"));
  it("does nothing in a danger variant", () => expect(enterAction({ ...base, enterConfirms: false })).toBe("none"));
  it("leaves Enter to a textarea", () => expect(enterAction({ ...base, inTextarea: true })).toBe("none"));
});

describe("tagPlan", () => {
  it("annotated with no message is refused, with the reason", () => {
    expect(tagPlan("v1.2.0", true, false, "")).toMatchObject({ ok: false, reason: "an annotated tag needs a message" });
  });
  it("annotated with only whitespace is still refused", () => {
    expect(tagPlan("v1.2.0", true, false, "  \n ").ok).toBe(false);
  });
  it("signed needs a message too", () => {
    expect(tagPlan("v1.2.0", false, true, "").reason).toBe("an annotated tag needs a message");
  });
  it("off and empty is a lightweight tag", () => {
    expect(tagPlan("v1.2.0", false, false, "")).toEqual({ ok: true, reason: "", opts: { annotated: false, signed: false, message: "" } });
  });
  it("off and whitespace is a lightweight tag", () => {
    expect(tagPlan("v1.2.0", false, false, "   ").opts).toEqual({ annotated: false, signed: false, message: "" });
  });
  it("off with a message is annotated, trimmed", () => {
    expect(tagPlan("v1.2.0", false, false, " ship it ").opts).toEqual({ annotated: true, signed: false, message: "ship it" });
  });
  it("signed sends signed and no separate annotated flag", () => {
    expect(tagPlan("v1.2.0", false, true, "ship").opts).toEqual({ annotated: false, signed: true, message: "ship" });
  });
  it("a tag without a name cannot be created", () => {
    expect(tagPlan("  ", false, false, "").ok).toBe(false);
  });
});

describe("pickerBody", () => {
  const o = { loading: false, error: null, total: 5, shown: 5, query: "" };
  it("rows", () => expect(pickerBody(o)).toBe("rows"));
  it("loading only while there is nothing to show", () => {
    expect(pickerBody({ ...o, loading: true, total: 0, shown: 0 })).toBe("loading");
    expect(pickerBody({ ...o, loading: true })).toBe("rows");
  });
  it("an error wins over loading", () => expect(pickerBody({ ...o, loading: true, error: "x", total: 0, shown: 0 })).toBe("error"));
  it("typed query with nothing left is no-match", () => expect(pickerBody({ ...o, shown: 0, query: "zz" })).toBe("no-match"));
  it("a list that was empty is empty", () => expect(pickerBody({ ...o, total: 0, shown: 0 })).toBe("empty"));
});

describe("dialogKeyScope: which dialog a key belongs to", () => {
  const base = { inOwn: true, inMenu: false, inOtherDialog: false, isTop: true };
  it("Escape inside a menu belongs to the menu, not to the dialog under it", () => {
    expect(dialogKeyScope({ key: "Escape", ...base, inOwn: false, inMenu: true })).toBe("ignore");
  });
  it("Escape inside another dialog belongs to that dialog", () => {
    expect(dialogKeyScope({ key: "Escape", ...base, inOwn: false, inOtherDialog: true })).toBe("ignore");
  });
  it("only the top dialog of a stack takes a key", () => {
    expect(dialogKeyScope({ key: "Escape", ...base, isTop: false })).toBe("ignore");
    expect(dialogKeyScope({ key: "Enter", ...base, isTop: false })).toBe("ignore");
  });
  it("Enter confirms only with the focus inside this dialog", () => {
    expect(dialogKeyScope({ key: "Enter", ...base, inOwn: false })).toBe("ignore");
    expect(dialogKeyScope({ key: "Enter", ...base })).toBe("handle");
  });
  it("Escape with nothing focused still closes the top dialog", () => {
    expect(dialogKeyScope({ key: "Escape", ...base, inOwn: false })).toBe("handle");
  });
});
