/*
 * The rows the Diff view lists, and the two parsers everything downstream trusts.
 *
 * This suite exists because of what the previous version of this list got wrong,
 * and every case below is one of those failures written down so it cannot come
 * back:
 *
 *   - every row was stamped with the time of the REQUEST, so the view showed the
 *     current clock on a file last touched two days ago, filed a three-week-old
 *     commit under "Today", and made sorting by time a no-op;
 *   - a row's identity was a hash of (staged?, path), so `git add` changed it and
 *     the reader lost their place and their review tick;
 *   - a partially staged file was two rows with nothing to tell them apart;
 *   - renames and binaries arrived with no status and rendered as a blank pane.
 *
 * The parsers get their own tests because both of git's `-z` formats have a
 * variable-arity record (a rename carries a second path) and a naive split does
 * not throw on it — it silently attributes every following file's status to its
 * neighbour, which is unreadable as a bug and invisible as a diff.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { changeRows, fileDiff, parseHunks, parseNameStatus, parseNumstat, parseStatusV2 } from "../src/changerows.ts";

/* ── the wire formats ─────────────────────────────────────────────────────── */

describe("git status --porcelain=v2 -z", () => {
  it("reads an ordinary modified file, and which side of the index it is on", () => {
    const rows = parseStatusV2("1 .M N... 100644 100644 100644 aaa bbb src/app.ts\0");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "src/app.ts", x: ".", y: "M" });
  });

  it("keeps a rename's ORIGINAL path, which arrives as its own field", () => {
    /* The record that shifts a naive parse: `2` is followed by the old path as a
       separate NUL-terminated field. Miss it and every subsequent file inherits
       the status of the one before — and a rename renders as a brand-new file
       with an empty diff, which is exactly what the old view showed. */
    const out =
      "2 R. N... 100644 100644 100644 aaa bbb R100 web/new.ts\0web/old.ts\0" +
      "1 .M N... 100644 100644 100644 ccc ddd server/index.ts\0";
    const rows = parseStatusV2(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "web/new.ts", oldPath: "web/old.ts" });
    // The proof that nothing shifted: the file after the rename is still itself.
    expect(rows[1]).toMatchObject({ path: "server/index.ts", y: "M" });
  });

  it("reads untracked files, and does not confuse them with modified ones", () => {
    const rows = parseStatusV2("? notes/draft.md\0");
    expect(rows[0]).toMatchObject({ path: "notes/draft.md", untracked: true });
  });

  it("keeps a path containing a space intact", () => {
    // The fields are space-separated up to the path, and the path is the rest.
    const rows = parseStatusV2("1 .M N... 100644 100644 100644 aaa bbb docs/my notes.md\0");
    expect(rows[0]!.path).toBe("docs/my notes.md");
  });

  it("survives an unmerged record, which has two more fields than the rest", () => {
    const out =
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts\0" +
      "1 .M N... 100644 100644 100644 ddd eee src/after.ts\0";
    const rows = parseStatusV2(out);
    expect(rows[0]!.path).toBe("src/conflict.ts");
    expect(rows[1]!.path).toBe("src/after.ts");
  });
});

describe("git diff --numstat -z", () => {
  it("adds up the staged and unstaged halves of one file", () => {
    // A partially staged file is two answers about one file. The row shows the
    // sum, because the reader is asking what changed, not where it is queued.
    const counts = parseNumstat("3\t1\tsrc/app.ts\0" + "\0" + "4\t0\tsrc/app.ts\0");
    expect(counts.get("src/app.ts")).toMatchObject({ add: 7, del: 1 });
  });

  it("marks a binary file rather than counting it as zero changes", () => {
    const counts = parseNumstat("-\t-\tassets/logo.png\0");
    expect(counts.get("assets/logo.png")).toMatchObject({ binary: true, add: 0, del: 0 });
  });

  it("files a rename under its destination, and does not shift the next entry", () => {
    /* The rename shape: counts, then an EMPTY path field, then <from> and <to>
       as two more fields. */
    const counts = parseNumstat("2\t2\t\0web/old.ts\0web/new.ts\0" + "9\t0\tweb/next.ts\0");
    expect(counts.get("web/new.ts")).toMatchObject({ add: 2, del: 2 });
    expect(counts.get("web/next.ts")).toMatchObject({ add: 9, del: 0 });
    expect(counts.has("web/old.ts")).toBe(false);
  });
});

describe("git diff --name-status -z", () => {
  it("names what happened to each file", () => {
    const kinds = parseNameStatus("A\0new.ts\0D\0gone.ts\0M\0kept.ts\0");
    expect(kinds.get("new.ts")).toMatchObject({ status: "added" });
    expect(kinds.get("gone.ts")).toMatchObject({ status: "deleted" });
    expect(kinds.get("kept.ts")).toMatchObject({ status: "modified" });
  });

  it("reads a rename's two paths without eating the next record", () => {
    const kinds = parseNameStatus("R100\0old.ts\0new.ts\0M\0after.ts\0");
    expect(kinds.get("new.ts")).toMatchObject({ status: "renamed", oldPath: "old.ts" });
    expect(kinds.get("after.ts")).toMatchObject({ status: "modified" });
  });
});

describe("the hunk parser", () => {
  it("reads a hunk header's four numbers, including the implicit 1", () => {
    const { hunks } = parseHunks("@@ -3 +3,2 @@\n context\n+added\n");
    expect(hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 });
  });

  it("keeps an empty context line as a space, not as nothing", () => {
    // A blank line inside a diff is a context line with no content. Dropped, the
    // two sides of a split view stop lining up from that point down.
    const { hunks } = parseHunks("@@ -1,3 +1,3 @@\n a\n\n b\n");
    expect(hunks[0]!.lines).toEqual([" a", " ", " b"]);
  });

  it("drops the no-newline marker, which is a note about the file, not a line", () => {
    const { hunks } = parseHunks("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(hunks[0]!.lines).toEqual(["-a", "+b"]);
  });

  it("says so when it stops early instead of pretending it rendered", () => {
    const body = Array.from({ length: 9000 }, (_, i) => `+line ${i}`).join("\n");
    const { truncated } = parseHunks(`@@ -0,0 +1,9000 @@\n${body}\n`);
    expect(truncated).toBe(true);
  });
});

/* ── against a real repository ────────────────────────────────────────────── */

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-rows-"));
  tmps.push(dir);
  const run = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run("init", "-q", "-b", "work");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  return dir;
}
const runIn = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const ref = (dir: string) => [{ root: dir, branch: "work", name: "tmp" } as never];

describe("what a row says about a file", () => {
  it("gives the time the FILE changed, not the time it was asked", async () => {
    /*
     * The bug this whole module was written for. Measured in the running app:
     * fourteen rows, five distinct stamps, every one of them equal to the clock
     * at the moment of the request — over files last touched two days earlier.
     */
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    // Backdate the file. A row that reports "now" cannot tell this from a file
    // saved this second, which is precisely the failure.
    const then = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(join(dir, "a.ts"), then, then);

    const { rows } = await changeRows(ref(dir), "working", null);
    const row = rows.find((r) => r.path === "a.ts")!;
    expect(Math.abs(row.changedAt - then.getTime())).toBeLessThan(2000);
    expect(Date.now() - row.changedAt).toBeGreaterThan(2 * 86_400_000);
  });

  it("keeps the same key when the file is staged", async () => {
    /* The old id was a hash of (staged?, path). Running `git add` therefore
       renamed the row, the selection fell through to the top of the list, and
       the review tick went with it — mid-read, from a command typed elsewhere. */
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");

    const before = (await changeRows(ref(dir), "working", null)).rows[0]!;
    runIn(dir, "add", "a.ts");
    const after = (await changeRows(ref(dir), "working", null)).rows[0]!;

    expect(after.key).toBe(before.key);
    expect(before.staged).toBe("none");
    expect(after.staged).toBe("full");
  });

  it("is ONE row for a partially staged file, and says so", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    runIn(dir, "add", "a.ts");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");

    const { rows } = await changeRows(ref(dir), "working", null);
    expect(rows.filter((r) => r.path === "a.ts")).toHaveLength(1);
    expect(rows[0]!.staged).toBe("partial");
  });

  it("carries a rename's old path, so it is not shown as a new file", async () => {
    const dir = repo();
    writeFileSync(join(dir, "old.ts"), "x\n".repeat(20));
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    runIn(dir, "mv", "old.ts", "new.ts");

    const { rows } = await changeRows(ref(dir), "working", null);
    const row = rows.find((r) => r.path === "new.ts")!;
    expect(row.status).toBe("renamed");
    expect(row.oldPath).toBe("old.ts");
  });

  it("counts an untracked file's lines rather than showing it as empty", async () => {
    const dir = repo();
    writeFileSync(join(dir, "seed.ts"), "x\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "fresh.ts"), "a\nb\nc\n");

    const { rows } = await changeRows(ref(dir), "working", null);
    const row = rows.find((r) => r.path === "fresh.ts")!;
    expect(row.status).toBe("untracked");
    expect(row.additions).toBe(3);
  });

  it("marks a binary file instead of promising a diff it cannot show", async () => {
    const dir = repo();
    writeFileSync(join(dir, "seed.ts"), "x\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));

    const { rows } = await changeRows(ref(dir), "working", null);
    expect(rows.find((r) => r.path === "blob.bin")!.binary).toBe(true);
  });

  it("keeps a checkout on the trunk branch, which used to be dropped entirely", async () => {
    /* The old endpoint filtered out any repo on main/master. A project whose
       only checkout is trunk therefore had a Diff view that was empty forever —
       both halves of it, since the client dropped those rows a second time. */
    const dir = repo();
    runIn(dir, "checkout", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");

    const { rows } = await changeRows([{ root: dir, branch: "main", name: "tmp" } as never], "working", null);
    expect(rows).toHaveLength(1);
  });

  it("dates a committed row by the COMMIT, and names it", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    // A commit dated well in the past: the row must report that date, not now.
    const when = Math.floor((Date.now() - 5 * 86_400_000) / 1000);
    spawnSync("git", ["-C", dir, "commit", "-aqm", "the second one"], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: `${when} +0000`, GIT_COMMITTER_DATE: `${when} +0000` },
    });

    const { rows } = await changeRows(ref(dir), "committed", null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commit?.subject).toBe("the second one");
    expect(Math.abs(rows[0]!.changedAt - when * 1000)).toBeLessThan(2000);
  });

  it("names a checkout it could not read instead of emptying the list", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    const broken = join(tmpdir(), "agx-rows-nonexistent-" + Date.now());

    const out = await changeRows([...ref(dir), { root: broken, branch: "x", name: "x" } as never], "working", null);
    expect(out.rows).toHaveLength(1);
    expect(out.failed).toEqual([broken]);
  });

  it("says how many rows it left out rather than ending a worktree short", async () => {
    const dir = repo();
    mkdirSync(join(dir, "many"), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, "many", `f${i}.ts`), "x\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, "many", `f${i}.ts`), "x\ny\n");

    const out = await changeRows(ref(dir), "working", null, 5);
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(7);
  });
});

describe("one file's diff", () => {
  it("is the whole change against the last commit, staged part included", async () => {
    /* Reading a file is not a staging question. The old view ran the two diffs
       separately and showed whichever row you clicked, so a partially staged
       file showed half its own change. */
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    runIn(dir, "add", "a.ts");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");

    const d = await fileDiff(dir, "a.ts", "working");
    const added = d.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith("+"));
    expect(added).toEqual(["+two", "+three"]);
  });

  it("renders an untracked file as every line added", async () => {
    const dir = repo();
    writeFileSync(join(dir, "seed.ts"), "x\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "fresh.ts"), "a\nb\n");

    const d = await fileDiff(dir, "fresh.ts", "working");
    expect(d.hunks[0]!.lines).toEqual(["+a", "+b"]);
  });

  it("refuses a path that climbs out of the repository", async () => {
    // The path arrives on the wire. Without this it is a read primitive for the
    // whole disk, wearing a git route's clothes.
    const dir = repo();
    const d = await fileDiff(dir, "../../etc/hosts", "working");
    expect(d.error).toBeTruthy();
    expect(d.hunks).toHaveLength(0);
  });

  it("signs its answer with the file's content, never with the clock", async () => {
    /* The signature is what lets the client cache a body it has already read.
       Keyed on a timestamp of the request it would miss on every poll; keyed on
       the content it cannot serve a stale diff either. */
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "one\n");
    runIn(dir, "add", "."); runIn(dir, "commit", "-qm", "first");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");

    const first = await fileDiff(dir, "a.ts", "working");
    const again = await fileDiff(dir, "a.ts", "working");
    expect(again.sig).toBe(first.sig);

    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
    expect((await fileDiff(dir, "a.ts", "working")).sig).not.toBe(first.sig);
  });
});
