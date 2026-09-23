/*
 * A test run cannot reach the database, settings or state of whoever runs it.
 *
 * The preload that makes this true is test/isolation.ts. Two halves are
 * asserted here: the redirect, in this process, and the guard, in a child
 * `bun test` — a refusal fails the run it happens in, on purpose, so it can
 * only be watched from outside that run.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childTargets, isRealAgentglassPath } from "./isolation";

const TMP = resolve(tmpdir());
const REAL = process.env.AGX_TEST_REAL_HOME!;
const underTmp = (p: string | undefined) => !!p && resolve(p).startsWith(TMP + "/");

describe("the redirect", () => {
  test("HOME and every XDG base are scratch", () => {
    for (const v of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      expect(underTmp(process.env[v]), `${v} is ${process.env[v]}`).toBe(true);
    }
  });

  test("the home it guards is the person's, even from a child run whose HOME is scratch", () => {
    expect(REAL).toBeTruthy();
    expect(underTmp(REAL)).toBe(false);
  });

  test("os.homedir() follows HOME, which bun on its own reads once at startup", () => {
    expect(homedir()).toBe(process.env.HOME!);
  });

  test("a child handed a HOME-less environment gets the scratch HOME, not the passwd one", () => {
    const r = Bun.spawnSync(["sh", "-c", "printf %s \"$HOME\""], { env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout.toString()).toBe(process.env.HOME!);
  });

  test("a child handed no environment at all gets this process's, not the one bun was launched with", async () => {
    /* The common spawn — git, tmux, sh — names no `env`, and bun gives it the
       environment the process STARTED with. Measured on 1.3.9: every git the
       suite ran read the real ~/.config/git/config. */
    const sh = 'printf "%s|%s" "$HOME" "$XDG_CONFIG_HOME"';
    const want = `${process.env.HOME}|${process.env.XDG_CONFIG_HOME}`;
    expect(Bun.spawnSync(["sh", "-c", sh]).stdout.toString()).toBe(want);
    expect(Bun.spawnSync({ cmd: ["sh", "-c", sh] }).stdout.toString()).toBe(want);
    expect(spawnSync("sh", ["-c", sh]).stdout.toString()).toBe(want);
    const p = Bun.spawn(["sh", "-c", sh], { stdout: "pipe" });
    expect(await new Response(p.stdout).text()).toBe(want);
  });
});

test("every suite in the repository loads it, and loads it first", async () => {
  /* First because bun freezes a builtin's exports the first time anything
     imports it, and the homedir patch has to land before that. Every suite,
     because each of them spawns or imports something that resolves a home. */
  for (const f of ["../../bunfig.toml", "../bunfig.toml", "../../web/bunfig.toml", "../../mobile/bunfig.toml"]) {
    const text = await Bun.file(new URL(f, import.meta.url).pathname).text();
    const first = text.match(/^preload = \["([^"]+)"/m);
    expect(first, `${f} has no preload`).not.toBeNull();
    expect(first![1]!.endsWith("/test/isolation.ts"), `${f} loads ${first![1]} first`).toBe(true);
  }
});

describe("what counts as real", () => {
  test("agentglass and agentglass-* under the person's own bases", () => {
    expect(isRealAgentglassPath(join(REAL, ".local/share/agentglass/agentglass.db"))).toBe(true);
    expect(isRealAgentglassPath(join(REAL, ".config/agentglass"))).toBe(true);
    expect(isRealAgentglassPath(join(REAL, ".cache/agentglass-browser/x"))).toBe(true);
    expect(isRealAgentglassPath(join(REAL, ".local/state/agentglass/tmux"))).toBe(true);
  });

  test("and nothing else", () => {
    expect(isRealAgentglassPath(join(REAL, ".config/git/config"))).toBe(false);
    expect(isRealAgentglassPath(join(REAL, ".config/agentglassy"))).toBe(false);
    expect(isRealAgentglassPath(join(REAL, "code/agentglass/server"))).toBe(false);
    expect(isRealAgentglassPath(join(process.env.HOME!, ".local/share/agentglass/agentglass.db"))).toBe(false);
  });

  test("a child's database follows the same fallbacks the server does", () => {
    expect(childTargets({ HOME: REAL })[0]).toBe(join(REAL, ".local/share/agentglass/agentglass.db"));
    expect(childTargets({ HOME: "/x", AGENTGLASS_STATE_DIR: "/s" })[0]).toBe("/s/agentglass.db");
    expect(childTargets({ HOME: "/x", AGENTGLASS_DB: "/d.db", AGENTGLASS_STATE_DIR: "/s" })[0]).toBe("/d.db");
    expect(childTargets({ HOME: "/x", XDG_CONFIG_HOME: "/c" })[1]).toBe("/c/agentglass");
    expect(childTargets({})[0]).toBe(join(REAL, ".local/share/agentglass/agentglass.db"));
  });
});

/** The fixture in a child `bun test`, and what it wrote down. */
function runFixture(env: Record<string, string>) {
  const report = join(mkdtempSync(join(tmpdir(), "agx-isolation-check-")), "report.json");
  const child = Bun.spawnSync(["bun", "test", "./test/fixtures/isolation-fixture.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env, ISOLATION_REPORT: report },
  });
  return { child, got: (): Record<string, string> => JSON.parse(readFileSync(report, "utf8")) };
}

test("a running agentglass's port and token do not reach a run started from its terminal", () => {
  /* Watched in a child, and a child that starts the way a person's run does:
     from a HOME that is not scratch, which is what makes it a first entry.
     In this process the variables say nothing — another file may have set
     one since the preload ran. */
  const { got } = runFixture({ HOME: "/nonexistent-agx-first-entry", AGENTGLASS_PORT: "4999", AGENTGLASS_TOKEN: "t" });
  const r = got();
  expect(r.agentglassVars).toBe("");
  expect(underTmp(r.home), `the child's HOME is ${r.home}`).toBe(true);
});

describe("the guard, watched from outside the run it fails", () => {
  const { child, got } = runFixture({});
  const err = child.stderr.toString();

  test("the run that reached a real path failed, and said which", () => {
    expect(child.exitCode).not.toBe(0);
    expect(err).toContain("refusal(s)");
    expect(err).toContain("agentglass-isolation-probe-absent");
  });

  test("and still cleaned up after itself: a refusal does not cost the scratch sweep", () => {
    expect(existsSync(got().scratch!)).toBe(false);
  });

  test("fs, sqlite and a spawn with the real HOME are each refused where they happen", () => {
    const r = got();
    for (const k of ["exists", "read", "db", "spawn"]) {
      expect(r[k], `${k} was not refused`).toContain("test isolation:");
    }
  });

  test("a child run inherits the parent's scratch home instead of making the real one its own", () => {
    const r = got();
    expect(r.home).toBe(process.env.HOME!);
    expect(r.homedir).toBe(process.env.HOME!);
    expect(r.filledHome).toBe(process.env.HOME!);
  });
});
