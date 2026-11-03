/*
 * Preflight reads the files the plan names: they land in the reviewer's directory, nothing outside the
 * project does, and the limits cut the list and say what was cut.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAMED_BYTES_MAX, NAMED_FILES_MAX, namedFiles, runPreflight, sliceOf } from "../src/preflight.ts";

const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
let dir: string, root: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-pfnamed-"));
  root = join(dir, "orbit"); mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "outside.ts"), "secret\n");
  symlinkSync(join(dir, "outside.ts"), join(root, "src", "link.ts"));
  symlinkSync(dir, join(root, "up"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("namedFiles", () => {
  test("backticked paths and path:line, each once, in the order named", () => {
    const r = namedFiles("See `src/b.ts` and src/a.ts:12-20, then `src/b.ts:3` again.", root);
    expect(r.files).toEqual([join(root, "src/b.ts"), join(root, "src/a.ts")]);
    expect(r.leftOut).toEqual([]);
  });
  test("outside the root, through a symlink, missing, or a directory: dropped", () => {
    const r = namedFiles("`../outside.ts` `src/link.ts` `up/outside.ts` `src/none.ts` `src` `/etc/passwd.conf`", root);
    expect(r.files).toEqual([]);
  });
  test("over the file limit: the first ones, the rest reported", () => {
    for (let i = 0; i < NAMED_FILES_MAX + 2; i++) writeFileSync(join(root, `f${i}.ts`), "x\n");
    const text = Array.from({ length: NAMED_FILES_MAX + 2 }, (_, i) => `\`f${i}.ts\``).join(" ");
    const r = namedFiles(text, root);
    expect(r.files.length).toBe(NAMED_FILES_MAX);
    expect(r.leftOut.map((l) => l.path)).toEqual([join(root, `f${NAMED_FILES_MAX}.ts`), join(root, `f${NAMED_FILES_MAX + 1}.ts`)]);
  });
  test("over the byte limit: later files left out", () => {
    writeFileSync(join(root, "big1.txt"), "x".repeat(NAMED_BYTES_MAX - 10));
    writeFileSync(join(root, "big2.txt"), "x".repeat(100));
    const r = namedFiles("`big1.txt` `big2.txt`", root);
    expect(r.files).toEqual([join(root, "big1.txt")]);
    expect(r.leftOut[0]).toMatchObject({ path: join(root, "big2.txt") });
  });
});

describe("the run", () => {
  test("a plan naming 2 files: both in the directory, the certificate says so, left-out ones are reported", async () => {
    const rec = join(dir, "rec.json");
    const { files, leftOut } = namedFiles("`src/a.ts` `src/b.ts`", root);
    const cert = await runPreflight(
      { files, leftOut: [{ path: "x.ts", reason: "over the limit" }], root, model: "sonnet", budgetUsd: 0.5, extraText: [{ name: "PLAN.md", body: "# Plan\n`src/a.ts` `src/b.ts`\n" }] },
      { bin: [process.execPath, STUB], env: { STUB_RECORD: rec } });
    const r = JSON.parse(readFileSync(rec, "utf8")) as { tree: { path: string }[]; argv: string[] };
    expect(r.tree.map((f) => f.path)).toEqual(["PLAN.md", "files/src/a.ts", "files/src/b.ts"]);
    expect(r.argv[r.argv.length - 1]).toContain("not a problem to report");
    expect(cert.read).toBe("Read PLAN.md + 2 files: src/a.ts, src/b.ts");
    expect(cert.skipped).toEqual([{ path: "x.ts", reason: "over the limit" }]);
    expect(leftOut).toEqual([]);
  });
});

describe("slices", () => {
  const numbered = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const text = (b: Buffer) => b.toString("utf8");

  test("namedFiles collects the cited ranges per file, ordered low to high", () => {
    const r = namedFiles("`src/a.ts:500` and src/a.ts:20-30, `src/b.ts`", root);
    expect(r.ranges).toEqual({ [join(root, "src", "a.ts")]: [[500, 500], [20, 30]] });
  });

  test("a cited line sends it ±40 plus the first 30 lines, under markers", () => {
    const r = sliceOf(numbered(1000), [[500, 500]]);
    expect(r.part).toBe("lines 1–30, 460–540");
    expect(text(r.data)).toBe(
      "… lines 1-30 …\n" + Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") +
      "\n… lines 460-540 …\n" + Array.from({ length: 81 }, (_, i) => `line ${460 + i}`).join("\n") + "\n");
  });

  test("ranges that touch merge, ranges apart stay two windows", () => {
    expect(sliceOf(numbered(1000), [[200, 210], [250, 260]]).part).toBe("lines 1–30, 160–300");
    expect(sliceOf(numbered(1000), [[200, 210], [400, 410]]).part).toBe("lines 1–30, 160–250, 360–450");
  });

  test("a range that covers the file sends it whole", () => {
    const b = numbered(60);
    const r = sliceOf(b, [[30, 30]]);
    expect(r.part).toBe("whole");
    expect(r.data).toEqual(b);
  });

  test("a big file named with no line: its first 200 lines, partial; a small one whole", () => {
    const big = Buffer.from(Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n") + "\n");
    const r = sliceOf(big, undefined);
    expect(r.part).toBe("partial");
    expect(text(r.data).split("\n").filter((l) => l.startsWith("line ")).length).toBe(200);
    expect(sliceOf(numbered(100), undefined).part).toBe("whole");
  });

  test("the run copies the slice, the certificate and the read line say so, and a path-only call stays whole", async () => {
    writeFileSync(join(root, "src", "big.ts"), numbered(20000));
    const rec = join(dir, "rec2.json");
    const plan = "Change `src/big.ts:15000` and `src/a.ts`.";
    const n = namedFiles(plan, root);
    const cert = await runPreflight(
      { files: n.files, ranges: n.ranges, root, model: "sonnet", budgetUsd: 0.5, extraText: [{ name: "PLAN.md", body: plan }] },
      { bin: [process.execPath, STUB], env: { STUB_RECORD: rec } });
    const big = cert.files.find((f) => f.path.endsWith("big.ts"))!;
    expect(big.part).toBe("lines 1–30, 14960–15040");
    expect(big.bytes).toBeLessThan(2000);
    expect(cert.files.find((f) => f.path.endsWith("a.ts"))!.part).toBe("whole");
    expect(cert.read).toBe("Read PLAN.md + 2 files: src/big.ts (lines 1–30, 14960–15040), src/a.ts (whole)");

    const whole = await runPreflight({ files: [join(root, "src", "big.ts")], root, model: "sonnet", budgetUsd: 0.5 }, { bin: [process.execPath, STUB], env: { STUB_RECORD: rec } });
    expect(whole.files[0]!.part).toBeUndefined();
    expect(whole.files[0]!.bytes).toBe(numbered(20000).length);
  });
});
