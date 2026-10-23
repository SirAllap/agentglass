/*
 * connect_otel.py edits a person's own Gemini settings. A file that is not
 * strict JSON (a comment, a trailing comma) used to read as {} and the write
 * replaced it with the telemetry block alone: "connected", and the person's
 * theme and the rest gone. It now leaves the file as it is and says why.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python = ["python3", "python", "py"].find((exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0);
const SCRIPT = join(import.meta.dir, "..", "..", "hooks", "connect_otel.py");
const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function connect(settings: string) {
  const home = mkdtempSync(join(tmpdir(), "agx-otel-"));
  homes.push(home);
  mkdirSync(join(home, ".gemini"));
  const file = join(home, ".gemini", "settings.json");
  writeFileSync(file, settings);
  const r = spawnSync(python!, [SCRIPT, "--only", "gemini"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, AGENTGLASS_SERVER: "http://127.0.0.1:4000" }, encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, after: readFileSync(file, "utf8") };
}

describe.skipIf(!python)("connect_otel gemini", () => {
  test("a settings file that is not strict JSON is left exactly as it was", () => {
    const original = '{\n  // my note\n  "theme": "dark"\n}\n';
    const r = connect(original);
    expect(r.after).toBe(original);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not valid JSON");
  });

  test("strict JSON keeps the person's other keys", () => {
    const r = connect('{"theme":"dark"}');
    expect(JSON.parse(r.after).theme).toBe("dark");
    expect(JSON.parse(r.after).telemetry.enabled).toBe(true);
  });
});
