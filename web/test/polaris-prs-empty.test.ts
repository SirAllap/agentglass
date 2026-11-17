import { describe, expect, test } from "bun:test";
import { prsEmptyNote } from "../src/lib/polarisPrsEmpty.ts";

const on = { ok: true, enabled: true, preset: "none" } as never;
const off = { ok: true, enabled: false, preset: "none" } as never;
const none = { ok: true, items: [], bases: [] } as never;
const some = { ok: true, items: [{ number: 1 }], bases: [] } as never;

describe("prsEmptyNote", () => {
  test("off", () => expect(prsEmptyNote(off, null, null)?.kind).toBe("off"));
  test("loading says nothing", () => { expect(prsEmptyNote(null, null, null)).toBeNull(); expect(prsEmptyNote(on, null, null)).toBeNull(); });
  test("on, nothing open", () => expect(prsEmptyNote(on, none, null)?.text).toBe("No open pull requests in this project."));
  test("rows: nothing", () => expect(prsEmptyNote(on, some, null)).toBeNull());
  test("error is the API sentence", () => expect(prsEmptyNote(null, null, "Could not reach it.")).toEqual({ kind: "error", text: "Could not reach it." }));
});
