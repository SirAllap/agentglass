/*
 * Where the judge runs.
 *
 * It ran in /tmp, on the reasoning that an empty directory gives a stray tool
 * call nothing to find. Claude Code reads its working directory BEFORE the
 * prompt — CLAUDE.md, `.claude/settings.json` (hooks: shell commands), `.mcp.json`
 * — and /tmp is world-writable, so any other account on the machine could
 * furnish every judgement with a hook of its choosing. The judge now runs in a
 * per-call 0700 directory under the app's state dir, with CLAUDE_CONFIG_DIR
 * pointed at a private directory rather than the operator's own, and the
 * directory is gone when the answer is in.
 *
 * Driven in a CHILD bun whose PATH holds nothing but a fake `claude` that
 * records where and with what it was run. `Bun.which` reads the PATH the
 * process started with — a PATH set in this process would still find the real
 * CLI, and the real CLI would be asked a question. The state dir, the database
 * and the XDG home are all scratch; nothing of the person's is read or written.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-judge-room-"));
const BIN = join(TMP, "bin");
const STATE = join(TMP, "state");
const SEEN = join(TMP, "claude-saw.json");
const DRIVER = join(TMP, "driver.ts");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const DRIVER_SRC = `
const U = await import(${JSON.stringify(join(import.meta.dir, "../src/understudy.ts"))});
const J = await import(${JSON.stringify(join(import.meta.dir, "../src/understudy-judge.ts"))});
U.setJudge(true);
U.addPrecedent({ cls: "C1", partition: "orbit", situation: "a widget review asks for a second reviewer", decision: "ask the squad lead", source: "probe", sourceRef: "p1", at: Date.now() });
const v = await J.judge({ situation: "a widget review asks for a second reviewer", cls: "C1", partition: "orbit" }, { timeoutMs: 5000 });
console.log(JSON.stringify({ v, state: ${JSON.stringify(STATE)} }));
`;

const ran = await (async () => {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(TMP, "xdg", "git"), { recursive: true });
  writeFileSync(join(TMP, "xdg", "git", "private-terms.txt"), "\\bnothing-private-here\\b\n");
  /* Records its cwd, the cwd's mode, its config dir, and whether the cwd held
     anything to read — then answers as a judge would. */
  writeFileSync(join(BIN, "claude"), [
    /* `/bin/bash` outright and a PATH of its own: the child's PATH is the fake's
       directory and nothing else, so `env` could not find bash nor this script
       `stat`. */
    "#!/bin/bash",
    "export PATH=/usr/bin:/bin",
    "cat >/dev/null",
    `printf '{"cwd":"%s","mode":"%s","config":"%s","entries":%s}' "$PWD" "$(stat -c %a "$PWD")" "$CLAUDE_CONFIG_DIR" "$(ls -A "$PWD" | wc -l)" > ${JSON.stringify(SEEN)}`,
    `echo '{"answer":"ask the squad lead","confidence":0.7,"why":"that is what the precedent says"}'`,
    "",
  ].join("\n"));
  chmodSync(join(BIN, "claude"), 0o755);
  writeFileSync(DRIVER, DRIVER_SRC);
  /* This bun by absolute path, since the child's PATH holds only the fake. */
  const proc = Bun.spawn([process.execPath, "run", DRIVER], {
    env: {
      HOME: process.env.HOME || "", PATH: BIN, NODE_ENV: "test",
      AGENTGLASS_DB: join(TMP, "t.db"), AGENTGLASS_STATE_DIR: STATE, XDG_CONFIG_HOME: join(TMP, "xdg"), XDG_STATE_HOME: join(TMP, "xdg-state"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() || "";
  let out: { v: { declined: boolean; answer: string; error?: string; why?: string } };
  try { out = JSON.parse(line); } catch { throw new Error(`driver said: ${stdout}${stderr}`); }
  if (!existsSync(SEEN)) throw new Error(`the judge answered without running the fake: ${line}\n${stderr}`);
  const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, "utf8")) as { cwd: string; mode: string; config: string; entries: number } : null;
  return { out, seen };
})();

describe("the judge's room", () => {
  it("asked the model — the fake was reached and its answer came back", () => {
    expect(ran.seen, "the fake claude was never run").not.toBeNull();
    expect(ran.out.v.declined).toBe(false);
    expect(ran.out.v.answer).toBe("ask the squad lead");
  });

  it("is not /tmp: a fresh, empty, 0700 directory under the app's state dir", () => {
    expect(ran.seen!.cwd).not.toBe("/tmp");
    expect(ran.seen!.cwd.startsWith(join(STATE, "judge") + "/")).toBe(true);
    expect(ran.seen!.mode).toBe("700");
    expect(ran.seen!.entries, "something was in the room before the judge").toBe(0);
  });

  it("is gone once the answer is in", () => {
    expect(existsSync(ran.seen!.cwd)).toBe(false);
    /* And the parent it was cut from is private too. */
    expect((statSync(join(STATE, "judge")).mode & 0o777).toString(8)).toBe("700");
    expect(readdirSync(join(STATE, "judge"))).toEqual([]);
  });

  it("does not read the operator's own Claude config", () => {
    expect(ran.seen!.config).toBe(join(STATE, "judge-claude"));
    expect((statSync(ran.seen!.config).mode & 0o777).toString(8)).toBe("700");
    /* Never an empty one: the credential is what lives there, so an install
       signed in through the browser still has a judge that can answer. The
       source is held to the same symlink the clone's pane uses. */
    const src = readFileSync(new URL("../src/understudy-judge.ts", import.meta.url), "utf8");
    expect(src).toContain('join(homedir(), ".claude", ".credentials.json")');
    expect(src).toContain("symlinkSync(cred, here)");
  });
});
