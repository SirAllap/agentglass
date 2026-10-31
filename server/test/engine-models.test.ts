import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOpencodeModels, engineModels, __resetEngineModels } from "../src/enginemodels.ts";

// `opencode models` prints bare `provider/model` lines; a banner or a blank
// line must not become a model.
const REAL_SHAPE = `acme/fast-1
acme/deep-2-preview-04-2026
orbit/chat:free

warning: update available
acme/fast-1
`;

beforeEach(() => __resetEngineModels());

test("parses provider/model lines, drops noise and duplicates", () => {
  expect(parseOpencodeModels(REAL_SHAPE).map((m) => m.id)).toEqual(["acme/fast-1", "acme/deep-2-preview-04-2026", "orbit/chat:free"]);
});

test("empty or unparseable output is an empty list", () => {
  expect(parseOpencodeModels("")).toEqual([]);
  expect(parseOpencodeModels("Error: not logged in")).toEqual([]);
});

test("an engine with no list gives an empty list", async () => {
  expect(await engineModels("hermes")).toEqual([]);
  expect(await engineModels("")).toEqual([]);
});

test("claude offers only the three aliases", async () => {
  const ids = (await engineModels("claude")).map((m) => m.id);
  expect(ids).toEqual(["haiku", "sonnet", "opus"]);
});

// Bun.which reads the PATH the process started with, so the stub CLI goes in a
// child that starts with it.
async function listIn(pathDir: string) {
  const dir = mkdtempSync(join(tmpdir(), "agx-em-"));
  try {
    if (pathDir === "stub") {
      writeFileSync(join(dir, "opencode"), "#!/bin/sh\nprintf 'acme/fast-1\\nacme/deep-2\\n'\n", { mode: 0o755 });
    }
    const p = Bun.spawn([process.execPath, "-e", `import {engineModels} from ${JSON.stringify(join(import.meta.dir, "../src/enginemodels.ts"))}; console.log(JSON.stringify((await engineModels("opencode")).map(m=>m.id)))`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, stdout: "pipe", stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return JSON.parse(out.trim().split("\n").pop()!) as string[];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("opencode models come from the CLI on PATH", async () => {
  expect(await listIn("stub")).toEqual(["acme/fast-1", "acme/deep-2"]);
});

test("opencode missing from PATH is an empty list, not an error", async () => {
  expect(await listIn("none")).toEqual([]);
});
