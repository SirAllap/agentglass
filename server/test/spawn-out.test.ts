// A blocking spawn on a request path froze the installed app five times in a
// row, up to 20 s: the server has one thread and it sat waiting for a child.
// These pin the replacement: the loop stays free, the limit still ends the
// child, a missing binary is an answer, and a newer run ends an older one.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOut } from "../src/spawnOut.ts";
import { spaceFor } from "../src/machine.ts";

const bodyOf = (source: string, head: string): string => {
  const at = source.indexOf(head);
  if (at < 0) return "";
  return source.slice(at, source.indexOf("\n}\n", at));
};
const machineSource = await Bun.file(new URL("../src/machine.ts", import.meta.url)).text();

describe("a child run beside the loop", () => {
  test("a timer ticks while the child runs, and its output comes back as text", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const r = await spawnOut(["sh", "-c", "sleep 0.3; printf 'orbit\\n'"], { timeoutMs: 5_000 });
    clearInterval(timer);
    expect(r).toEqual({ stdout: "orbit\n", stderr: "", exitCode: 0, killed: false });
    expect(ticks).toBeGreaterThan(5);
  });

  test("the limit ends the child and keeps what had arrived", async () => {
    const t0 = performance.now();
    const r = await spawnOut(["sh", "-c", "printf 'first\\n'; exec sleep 30"], { timeoutMs: 300 });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r.killed).toBe(true);
    expect(r.stdout).toBe("first\n");
  });

  test("a binary that is not there is an answer, not a throw", async () => {
    expect(await spawnOut(["/nonexistent/acme-orbit-tool"], { timeoutMs: 1_000 }))
      .toEqual({ stdout: "", stderr: "", exitCode: null, killed: false });
  });

  test("a newer run with the same key ends the older one; another key is left alone", async () => {
    const old = spawnOut(["sh", "-c", "exec sleep 30"], { timeoutMs: 20_000, latest: "search:/home/dev/orbit" });
    const other = spawnOut(["sh", "-c", "sleep 0.2; printf 'kept\\n'"], { timeoutMs: 20_000, latest: "search:/home/dev/acme" });
    const fresh = await spawnOut(["sh", "-c", "printf 'new\\n'"], { timeoutMs: 20_000, latest: "search:/home/dev/orbit" });
    expect(fresh).toEqual({ stdout: "new\n", stderr: "", exitCode: 0, killed: false });
    expect((await old).killed).toBe(true);
    expect(await other).toEqual({ stdout: "kept\n", stderr: "", exitCode: 0, killed: false });
  });
});

describe("the size of a folder is measured beside the loop", () => {
  test("du runs while a timer ticks, and the report is the one it always was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-space-"));
    try {
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "node_modules", "big.bin"), "x".repeat(50_000));
      writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 1);
      const r = await spaceFor(dir);
      clearInterval(timer);
      expect(r.error).toBeUndefined();
      expect(r.dirs.map((d) => d.name)).toEqual(["node_modules", "src"]);
      expect(r.dirs[0]!.reclaimable).toBe(true);
      expect(r.bytes).toBeGreaterThan(50_000);
      expect(r.freeable).toBe(r.dirs[0]!.bytes);
      expect(ticks).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the function no longer holds a blocking spawn", () => {
    const body = bodyOf(machineSource, "export async function spaceFor(");
    expect(body.length).toBeGreaterThan(0);
    expect(body.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")).not.toContain("spawnSync");
  });
});
