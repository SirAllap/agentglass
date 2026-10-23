/*
 * The decisions behind the Compress, Properties and Move to… dialogs: the
 * archive's default name, which formats may take a password, how a mode reads
 * as the nine toggles, and which folders a destination picker may offer.
 */
import { describe, expect, test } from "bun:test";
import { archiveName, compressSub, formatTakesPassword, modeBits, modeSymbolic, toggleMode, destProblem, trashDeleteWords, canExec, toggleExec, kindWords, foldersOf } from "../src/lib/finderOps.ts";

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

describe("Properties, as Strata words it", () => {
  test("the line under the name says what the entry is", () => {
    expect(kindWords("acme-notes.md", "file")).toBe("Markdown document");
    expect(kindWords("orbit", "dir")).toBe("Folder");
    expect(kindWords("x.weird", "file")).toBe("WEIRD file");
    expect(kindWords("Makefile", "file")).toBe("File");
  });
  test("the +x box is on when any execute bit is, and flips all three together", () => {
    expect(canExec(0o644)).toBe(false);
    expect(canExec(0o744)).toBe(true);
    expect(toggleExec(0o644)).toBe(0o755);
    expect(toggleExec(0o755)).toBe(0o644);
    expect(toggleExec(0o100)).toBe(0o000);
  });
  test("every dialog opens with the same header: tile, title, close button", async () => {
    const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
    const d = await src("components/finder/machine/FinderDialogs.tsx");
    expect((d.match(/<DialogHead /g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(await src("components/finder/machine/FinderCustomize.tsx")).toContain("<DialogHead ");
  });
});

describe("the folder picker lists the place it is in", () => {
  // A double-click on a folder: the first click renders the new place while the old list is still on screen, and the second click on the same name went into ".../sub/sub".
  const loaded = { at: "/h/a", names: ["sub", "other"] };
  test("a list read for another place is not shown", () => {
    expect(foldersOf("/h/a", loaded)).toEqual(["sub", "other"]);
    expect(foldersOf("/h/a/sub", loaded)).toBeNull();
    expect(foldersOf("/h/a", null)).toBeNull();
  });
  test("the picker shows only that", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/FinderDialogs.tsx", import.meta.url)).text();
    expect(t).toContain("const dirs = foldersOf(at, loaded);");
    expect(t).toContain("setLoaded({ at, names:");
  });
});
