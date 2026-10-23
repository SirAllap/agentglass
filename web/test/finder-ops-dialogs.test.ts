/*
 * The decisions behind the Compress, Properties and Move to… dialogs: the
 * archive's default name, which formats may take a password, how a mode reads
 * as the nine toggles, and which folders a destination picker may offer.
 */
import { describe, expect, test } from "bun:test";
import { archiveName, compressSub, formatTakesPassword, modeBits, modeSymbolic, toggleMode, destProblem, trashDeleteWords } from "../src/lib/finderOps.ts";

describe("compress", () => {
  test("one item keeps its name, several are called Archive", () => {
    expect(archiveName(["acme-notes.md"])).toBe("acme-notes.md");
    expect(archiveName(["a", "b"])).toBe("Archive");
  });
  test("the subtitle counts files and folders", () => {
    expect(compressSub([{ dir: false }])).toBe("1 file");
    expect(compressSub([{ dir: true }, { dir: false }, { dir: false }])).toBe("2 files, 1 folder");
  });
  test("only zip and 7z take a password", () => {
    expect(formatTakesPassword("zip")).toBe(true);
    expect(formatTakesPassword("7z")).toBe(true);
    expect(formatTakesPassword("tar.gz")).toBe(false);
    expect(formatTakesPassword("tar")).toBe(false);
  });
});

describe("permissions", () => {
  test("644 reads as -rw-r--r--", () => {
    expect(modeSymbolic(0o644, "file")).toBe("-rw-r--r--");
    expect(modeSymbolic(0o755, "dir")).toBe("drwxr-xr-x");
  });
  test("the nine bits, owner first", () => {
    expect(modeBits(0o640)).toEqual({ owner: [true, true, false], group: [true, false, false], others: [false, false, false] });
  });
  test("a toggle flips one bit and keeps the rest, including the high ones", () => {
    expect(toggleMode(0o644, "owner", 2)).toBe(0o744);
    expect(toggleMode(0o4755, "others", 0) & 0o7000).toBe(0o4000);
    expect(toggleMode(0o755, "others", 0)).toBe(0o751);
  });
});

describe("a destination", () => {
  test("a folder cannot go into itself or below itself", () => {
    expect(destProblem(["/h/a"], "/h/a")).toMatch(/into itself/);
    expect(destProblem(["/h/a"], "/h/a/b")).toMatch(/into itself/);
    expect(destProblem(["/h/a"], "/h/ab")).toBeNull();
  });
  test("a move into where it already is is nothing to do", () => {
    expect(destProblem(["/h/a/x"], "/h/a", "move")).toMatch(/already/);
    expect(destProblem(["/h/a/x"], "/h/a", "copy")).toBeNull();
  });
});

describe("the trash", () => {
  test("deleting from it says the count and the names", () => {
    expect(trashDeleteWords(["a.txt"]).title).toBe("Delete “a.txt” for good?");
    const w = trashDeleteWords(["a", "b", "c", "d", "e", "f", "g"]);
    expect(w.title).toBe("Delete 7 items for good?");
    expect(w.body).toContain("and 2 more");
    expect(w.body).toContain("cannot be undone");
  });
  test("emptying the whole trash is asked as Strata asks it, with a button that says so", () => {
    const w = trashDeleteWords(["a", "b"], true);
    expect(w.title).toBe("Empty Trash?");
    expect(w.confirm).toBe("Empty Trash");
    expect(w.body).toContain("2 items");
    expect(w.body).toContain("cannot be undone");
    expect(trashDeleteWords(["a"], true).body).toContain("1 item ");
    expect(trashDeleteWords(["a"]).confirm).toBe("Delete for good");
  });
});
