/*
 * The sentences somebody writes over and over on other people's pull requests.
 *
 * The rules worth pinning are the ones about what does NOT happen: nothing ships in
 * the list (these go out under somebody's name), an empty reply is refused rather
 * than stored as a menu row that inserts nothing, and an edit is an edit rather than
 * a delete-and-add — a saved reply is referred to by id from a menu that may be open
 * while it is being changed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REPLIES, __setSavedRepliesPath, putSavedReply, removeSavedReply, savedReplies } from "../src/savedReplies.ts";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-replies-"));
  file = join(dir, "saved-replies.json");
  __setSavedRepliesPath(file);
});
afterEach(() => {
  __setSavedRepliesPath(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("saved replies", () => {
  test("start empty — nothing is put in somebody's mouth", () => {
    expect(savedReplies()).toEqual([]);
  });

  test("an added one comes back with an id and the title it was given", () => {
    const r = putSavedReply({ title: "Handing it over", text: "Thanks — we will take this on from here." });
    expect(r.ok).toBe(true);
    expect(r.replies).toHaveLength(1);
    expect(r.replies![0]).toMatchObject({ title: "Handing it over", text: "Thanks — we will take this on from here." });
    expect(r.replies![0]!.id).toBeTruthy();
  });

  test("with no title, the first line becomes one", () => {
    const r = putSavedReply({ text: "Needs a test that fails without the fix.\nAnd a note on the card." });
    expect(r.replies![0]!.title).toBe("Needs a test that fails without the fix.");
  });

  // A menu row that inserts nothing reads as a broken menu.
  test("one that says nothing is refused", () => {
    expect(putSavedReply({ title: "empty", text: "   " }).ok).toBe(false);
    expect(savedReplies()).toEqual([]);
  });

  test("editing keeps the id, so a menu holding it still points at the same thing", () => {
    const id = putSavedReply({ text: "first" }).replies![0]!.id;
    const after = putSavedReply({ id, title: "Renamed", text: "second" });
    expect(after.replies).toHaveLength(1);
    expect(after.replies![0]).toMatchObject({ id, title: "Renamed", text: "second" });
  });

  test("and an edit with no title keeps the one it had", () => {
    const first = putSavedReply({ title: "Kept", text: "a" }).replies![0]!;
    const after = putSavedReply({ id: first.id, title: "", text: "b" });
    expect(after.replies![0]).toMatchObject({ title: "Kept", text: "b" });
  });

  test("deleting one leaves the rest", () => {
    const a = putSavedReply({ text: "a" }).replies![0]!;
    putSavedReply({ text: "b" });
    const after = removeSavedReply(a.id);
    expect(after.replies.map((r) => r.text)).toEqual(["b"]);
  });

  test("deleting something that is not there changes nothing", () => {
    putSavedReply({ text: "a" });
    expect(removeSavedReply("nope").replies).toHaveLength(1);
  });

  test("the list is capped, and says why", () => {
    for (let i = 0; i < MAX_REPLIES; i++) putSavedReply({ text: `reply ${i}` });
    const over = putSavedReply({ text: "one too many" });
    expect(over.ok).toBe(false);
    expect(over.error).toContain("menu");
    expect(savedReplies()).toHaveLength(MAX_REPLIES);
  });

  // A malformed file is not a reason to lose the composer's menu — and the file is
  // left alone, so whatever was in it can still be rescued by hand.
  test("a broken file reads as no replies rather than as a crash", () => {
    writeFileSync(file, "{ this is not json");
    __setSavedRepliesPath(file);
    expect(savedReplies()).toEqual([]);
  });

  test("and a file with rubbish in the list keeps only what is really a reply", () => {
    writeFileSync(file, JSON.stringify({ replies: [{ id: "a", title: "t", text: "x" }, { nope: true }, null] }));
    __setSavedRepliesPath(file);
    expect(savedReplies()).toEqual([{ id: "a", title: "t", text: "x" }]);
  });
});
