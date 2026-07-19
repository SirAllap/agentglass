// makeCommands + scriptCommands from #10 wishlist.
// Uses real temp dirs so runner detection / -C paths stay honest.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCommands, scriptCommands, shellSafeRel } from "../src/terminal.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ag-cmd-"));
  // root Makefile with inline + above-comment descriptions, assignment noise
  writeFileSync(
    join(root, "Makefile"),
    [
      "CC := gcc",
      "build: ## build it",
      "\t$(CC) main.c",
      "# run unit tests",
      "test: build",
      "\tgo test ./...",
      "-evil: ## should be skipped",
      "\techo no",
      "deploy: ## ship it",
      "\techo ship",
      "",
    ].join("\n"),
  );
  // nested package with bun lockfile
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", "package.json"), JSON.stringify({
    scripts: {
      dev: "vite",
      "build:prod": "vite build",
      "bad name": "echo no",
      ";rm": "echo no",
    },
  }));
  writeFileSync(join(root, "web", "bun.lock"), "");
  // nested make
  mkdirSync(join(root, "packages"));
  mkdirSync(join(root, "packages", "api"));
  writeFileSync(
    join(root, "packages", "api", "Makefile"),
    "serve: ## run api\n\tgo run .\n",
  );
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("shellSafeRel", () => {
  test("accepts plain relative paths and rejects metacharacters", () => {
    expect(shellSafeRel("web")).toBe(true);
    expect(shellSafeRel("packages/api")).toBe(true);
    expect(shellSafeRel("; rm -rf ~")).toBe(false);
    expect(shellSafeRel("a b")).toBe(false);
  });
});

describe("makeCommands", () => {
  test("parses root Makefile targets with ## and comment-above descriptions", () => {
    const cmds = makeCommands(root);
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
    expect(byName.build?.cmd).toBe("make build");
    expect(byName.build?.desc).toBe("build it");
    expect(byName.test?.desc).toBe("run unit tests");
    expect(byName.deploy?.desc).toBe("ship it");
    // leading-dash "targets" must never become make flags
    expect(byName["-evil"]).toBeUndefined();
  });

  test("includes nested Makefile targets with make -C", () => {
    const cmds = makeCommands(root);
    const serve = cmds.find((c) => c.name === "serve" && c.dir === "packages/api");
    expect(serve?.cmd).toBe("make -C packages/api serve");
    expect(serve?.desc).toBe("run api");
  });
});

describe("scriptCommands", () => {
  test("uses bun --cwd when bun.lock is present and filters bad script names", () => {
    const cmds = scriptCommands(root);
    const web = cmds.filter((c) => c.dir === "web");
    const byName = Object.fromEntries(web.map((c) => [c.name, c]));
    expect(byName.dev?.cmd).toBe("bun run --cwd web dev");
    expect(byName["build:prod"]?.cmd).toBe("bun run --cwd web build:prod");
    expect(byName["bad name"]).toBeUndefined();
    expect(byName[";rm"]).toBeUndefined();
  });
});
