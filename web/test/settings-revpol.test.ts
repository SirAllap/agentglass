import { describe, expect, test } from "bun:test";
import { listSave } from "../src/components/settings/save/useInstantSave.ts";
import { getSaveToast, undoSaveToast, dismissSaveToast } from "../src/components/settings/save/saveToasts.ts";
import { getCustomPrefix, setCustomPrefix } from "../src/components/settings/pages/customPrefix.ts";

// A store with the PermissionsPage diff: it reads "before" from the caller, never a closed-over value.
function store(init: string) {
  const s = { v: init };
  const onSave = (next: string, before: string) => {
    const was = new Set(before.split("\n").filter(Boolean));
    for (const x of new Set(next.split("\n").filter(Boolean))) was.delete(x);
    const now = new Set(next.split("\n").filter(Boolean));
    const keep = new Set(s.v.split("\n").filter(Boolean));
    for (const x of was) keep.delete(x);
    for (const x of now) keep.add(x);
    s.v = [...keep].sort().join("\n");
  };
  return { s, onSave };
}

describe("list Undo", () => {
  test("remove then Undo puts the item back; a second edit works too", () => {
    const { s, onSave } = store("a\nb");
    listSave(s.v, "a", onSave); // remove b
    expect(s.v).toBe("a");
    expect(getSaveToast()).not.toBeNull();
    undoSaveToast();
    expect(s.v).toBe("a\nb");
    listSave(s.v, "b", onSave); // second edit: remove a
    expect(s.v).toBe("b");
    undoSaveToast();
    expect(s.v).toBe("a\nb");
    dismissSaveToast();
  });
});

describe("custom prefix flag", () => {
  test("one shared flag: Custom… in one row is seen by the other", () => {
    setCustomPrefix(true);
    expect(getCustomPrefix()).toBe(true);
    setCustomPrefix(false);
    expect(getCustomPrefix()).toBe(false);
  });
});
