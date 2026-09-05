/*
 * The four seals that are proofs about ACTING.
 *
 * The panel shows six. Two are measured continuously from the ledger — every
 * answer had a seal in front of it, no prediction arrived after the answer —
 * and they are green or red on real data. These are the other four, and they
 * are different in kind: they are not measurements of how well it predicts, but
 * proofs about what it can reach if it ever acts.
 *
 * WHY THEY EXIST AS TESTS AND NOT AS SETTINGS. The panel deliberately has no
 * control that turns autonomy on. The rungs above `queued` are unreachable in
 * this build, and what would make them reachable is not somebody clicking but
 * these four passing. A safety property that lives in a checkbox is a promise;
 * a safety property that lives in a test that fails when it is violated is a
 * fact.
 *
 * WHAT EACH ONE ACTUALLY ASSERTS, given that nothing in this build acts:
 *
 *   Three of them are about the ROUTE TABLE, and can be proven right now
 *   without anything acting at all — because the fence is not "the actuator
 *   declines", it is "the route does not exist for this principal". That is a
 *   stronger claim and a testable one.
 *
 *   The fourth — halt restores a snapshot mid-sequence — cannot be proven,
 *   because there is no multi-step act to interrupt. It is `test.todo` with the
 *   reason in the file. A green tick for a test that has never run is the most
 *   expensive lie a safety panel can tell, and a skipped assertion dressed up
 *   as a pass is the same lie in quieter clothes.
 */
import { describe, expect, test, beforeAll } from "bun:test";

/**
 * The end of the declaration that starts at `from`, for tests that read shape.
 *
 * Bounding a source slice by a character count is the thing that broke five
 * tests in one afternoon: every time, somebody had added a paragraph of
 * comment inside the function and pushed the assertion past the cut. A test
 * that fails because the code got better documented is one people delete.
 */
function endOfBlock(text: string, from: number): number {
  const close = text.indexOf("\n}", from);
  return close === -1 ? text.length : close;
}
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let AUTH: typeof import("../src/auth.ts");

beforeAll(async () => {
  const jail = mkdtempSync(join(tmpdir(), "agx-seals-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  AUTH = await import("../src/auth.ts");
});

/** A caller wearing the understudy's own principal. */
const understudy = () => ({ kind: "machine" as const, scope: "full" as const, principal: "understudy" as const });

describe("seal: argv and free text cannot reach a shell", () => {
  /*
   * The two routes that would let it run anything.
   *
   * `/terminal/tmux/windows` takes an argv that is joined into a shell string
   * by tmuxlayout.ts, and `/chat/send` takes free text that becomes a prompt.
   * Either one is a shell, one mis-prediction away. The fence is that the
   * understudy's allowlist is POSITIVE and neither route is on it — so this is
   * not a matter of the actuator choosing well, it is a matter of the route not
   * existing for this caller.
   */
  test("neither route is reachable by the understudy principal", () => {
    expect(AUTH.allowed(understudy(), "POST", "/terminal/tmux/windows")).toBe(false);
    expect(AUTH.allowed(understudy(), "POST", "/chat/send")).toBe(false);
    expect(AUTH.allowed(understudy(), "POST", "/chat/pane/key")).toBe(false);
  });

  test("and they are not on the allowlist by name, so adding them is a visible act", () => {
    // Enumerated rather than probed: a route added to UNDERSTUDY_POST without
    // a line here is a change to what this thing may do, and it should fail a
    // test rather than pass quietly.
    const list = [...AUTH.UNDERSTUDY_POST].sort();
    expect(list).not.toContain("/terminal/tmux/windows");
    expect(list).not.toContain("/chat/send");
    expect(list).not.toContain("/chat/pane/key");
  });
});

describe("seal: it cannot reach the things that leave this machine", () => {
  /*
   * A push, a task-tracker write, a review posted under his name. These are
   * the `outward` rung of the reach ladder, and the ladder cannot select it —
   * but the ladder is a preference and this is the fence. Refused at the route
   * table whatever any setting says.
   */
  test("push, task tracker and review-as-you are all refused", () => {
    for (const route of [
      "/git/push",
      "/clickup/task",
      "/clickup/comment",
      "/prs/review",
      "/prs/comment",
      "/prs/merge",
      "/prs/close",
    ]) {
      expect(AUTH.allowed(understudy(), "POST", route), `${route} must be refused`).toBe(false);
    }
  });

  test("a gate is not something it may answer on somebody's behalf", () => {
    // C6 is key-locked in the class table for the same reason this route is
    // refused here: answering a permission prompt is answering FOR a person.
    // Two independent statements of one rule, which is deliberate — the class
    // lock is a policy and this is a fence.
    expect(AUTH.allowed(understudy(), "POST", "/gate/decide")).toBe(false);
  });
});

describe("seal: the fence is not inert", () => {
  /*
   * The most dangerous property this design has, and the reason the feature
   * refuses to enable itself without a token.
   *
   * On a zero-config loopback install `resolveToken()` returns no token, and
   * index.ts skips the whole caller block — so `allowed()` is never consulted
   * and every principal fence above is decoration. A test suite that only ever
   * spawns a server WITH a token would be green over that.
   */
  test("enabling is refused when there is no auth token to fence with", () => {
    expect(typeof AUTH.understudyRequiresToken).toBe("function");
    expect(AUTH.understudyRequiresToken(null)).toBe(true);
    expect(AUTH.understudyRequiresToken("a-real-token")).toBe(false);
  });

  test("the refusal says why, in words a person can act on", () => {
    expect(AUTH.UNDERSTUDY_NO_TOKEN_ERROR).toContain("token");
  });
});

describe("seal: a child agent inherits none of this app's reach", () => {
  /*
   * OFF `todo`, and the reason is that the child finally exists.
   *
   * This read "not proven" for as long as nothing in the build launched
   * anything, which was the honest state then: writing a test that spawns
   * nothing and passes is worse than having no test. The judge changed that.
   * It is the only process the understudy starts, so it is the child the seal
   * has always been about, and every clause of the claim can now be checked
   * against a real argv rather than against an intention.
   *
   * The claim was: no MCP tools, no credential, no way to push. All three fall
   * out of the same three flags, which is why they are asserted together.
   */
  test("the only child it launches is given no tools at all", async () => {
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    const argv = src.slice(src.indexOf("const argv = ["), src.indexOf("];", src.indexOf("const argv = [")));

    // An EMPTY allowlist, not a curated one. A list of permitted tools is a
    // list somebody widens later for a good reason; an empty one has no
    // gradient to slide down.
    expect(argv).toContain('"--allowedTools", ""');
    // And a prompting permission mode with no terminal to prompt at, so a tool
    // call cannot succeed even if the model attempted one.
    expect(argv).toContain('"--permission-mode", "default"');
    expect(argv).not.toContain("dangerously-skip-permissions");
  });

  test("it cannot push, because it has nowhere to push from", async () => {
    /*
     * `git push --dry-run` inside the child fails for a reason stronger than a
     * refused permission: the child runs in a directory this server just made
     * empty, which is not a repository, and it has no tool with which to run
     * git in the first place. Two independent reasons, and the test asserts the
     * one that cannot be argued with.
     *
     * That directory used to be /tmp, and this test pinned the string. /tmp is
     * world-writable, and the CLI reads CLAUDE.md, `.claude/settings.json`
     * (hooks) and `.mcp.json` from its cwd before the prompt — so another
     * account on the machine could furnish every judgement. The room is now a
     * per-call 0700 mkdtemp under the app's state dir (understudy-judge-room.test.ts
     * drives it); what this test keeps is that it is still not a repository
     * and still carries no credential.
     */
    const src = await Bun.file(new URL("../src/understudy-judge.ts", import.meta.url)).text();
    expect(src).toContain("cwd: room.cwd");
    expect(src).toContain('mkdtempSync(join(rooms, "run-"))');
    expect(src).not.toContain('cwd: "/tmp"');
    // The ONE thing the env adds is the private config directory: no repository
    // path, no token. Pinned as the whole object so a second key cannot arrive
    // without changing this line.
    expect(src).toContain("env: { ...process.env, CLAUDE_CONFIG_DIR: room.config }");
    expect(src.match(/\benv:\s*\{/g)).toHaveLength(1);
    expect(src).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|AGENTGLASS_TOKEN/);
  });

  test("the judge is the only AGENT it launches — everything else is a tool", async () => {
    /*
     * The seal is about children in general, so it is worth knowing exactly
     * which ones exist. There are two kinds and they are not the same risk.
     *
     * `git`, spawned by the backtest, is a TOOL: a fixed argv, arguments the
     * caller chose, no env, no prompt, no discretion. It cannot be talked into
     * anything because there is nobody in there to talk to.
     *
     * The judge is an AGENT: a model, given text, capable of deciding to do
     * something. That is the child this seal has always been about, and the
     * assertions above are what bound it.
     *
     * Enumerated by binary, so a THIRD kind appearing — a shell, a second
     * agent — fails here rather than blending into a list of things that were
     * always fine.
     */
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const spawns: { where: string; line: string }[] = [];
    for (const f of readdirSync(dir).filter((x) => x.startsWith("understudy") && x.endsWith(".ts"))) {
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        if (/\bBun\.spawn\s*\(/.test(code)) spawns.push({ where: `${f}:${i + 1}`, line: code });
      });
    }
    expect(spawns.length, "there should be children to check").toBeGreaterThan(0);

    for (const s of spawns) {
      const isGit = /\["git"/.test(s.line);
      const isJudge = s.where.startsWith("understudy-judge.ts");
      expect(isGit || isJudge, `${s.where} is neither git nor the judge: ${s.line.trim()}`).toBe(true);
    }
    // And exactly one file may launch an agent.
    const agents = new Set(spawns.filter((s) => !/\["git"/.test(s.line)).map((s) => s.where.split(":")[0]));
    expect([...agents]).toEqual(["understudy-judge.ts"]);
  });
});

/*
 * THE SEALS THAT CAME OFF `todo` WHEN THE QUEUE WAS BUILT.
 *
 * These were unprovable while nothing acted, and they were honest about it. A
 * queue changes that: an approved proposal is a real request against a real
 * repository, so the properties below stopped being hypothetical the moment it
 * shipped and are asserted here instead of being described.
 *
 * They are still not "the understudy acts safely" — nothing here lets it act on
 * its own. They are the narrower claim the build can actually support: that the
 * path which DOES act cannot be reached except through a person, cannot be
 * aimed by a caller, and cannot be made to run twice.
 */
describe("seal: what the queue can reach is bounded before anybody presses", () => {
  test("nothing can ask the understudy to draft a proposal", async () => {
    /*
     * The route that would have been convenient and is the hole: a caller who
     * can request a proposal is a caller who can aim the understudy at a
     * repository of their choosing and then approve their own suggestion.
     *
     * Proposals are made only by the seam that seals a situation, so this is
     * asserted as an absence — enumerated by name, because a route added later
     * should fail a test rather than pass quietly.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).not.toContain('"/understudy/propose"');
    expect(src).not.toContain('"/understudy/queue/add"');
  });





  test("a shift cannot extend itself", async () => {
    const Shift = await import("../src/understudy-shift.ts");
    // Every other limit here is enforced somewhere. This one is enforced by the
    // absence of a way to do it, which is the strongest version available.
    expect(Object.keys(Shift)).not.toContain("extend");
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).not.toContain('"/understudy/shift/extend"');
  });
});

describe("seal: halt puts back what it did", () => {
  /*
   * OFF `todo`, and what took it off was not a better test — it was a
   * sequence existing to interrupt.
   *
   * While nothing could act, "halt stops it" and "halt puts everything back"
   * were the same sentence, because nothing was ever standing. The moment a
   * shift could act they came apart: stopping prevents the next thing and
   * leaves everything already done exactly where it is. A halt that only
   * stopped would have been the most dangerous kind of button — one whose name
   * promises more than it does.
   */
  test("halting a shift stops it, and the work it did stays on disk", async () => {
    /*
     * THIS SEAL USED TO READ "halt puts everything back", and it was answered
     * by unwinding a table of reversible acts — a table that never held a row,
     * so the unwinding never ran.
     *
     * The promise did not disappear, it moved. Work happens in a DISPOSABLE
     * WORKTREE, so putting everything back is removing a directory, and that
     * is precisely why the agent can be handed every tool in the first place.
     *
     * Which is also why halting must NOT delete anything: that directory holds
     * the only copy of whatever it had done. Throwing it away is a decision
     * somebody makes after reading it.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    /*
     * Bounded by the NEXT ROUTE, not by the end of a function. A route handler
     * is a branch inside one enormous if/else, so `\n}` lands somewhere far
     * below it and drags in whatever comes next — which is how this assertion
     * started reading other routes' mentions of worktrees.
     */
    const from = src.indexOf('pathname === "/understudy/halt"');
    const next = src.indexOf("if (pathname ===", from + 20);
    const block = src.slice(from, next === -1 ? from + 2500 : next);
    expect(block).toContain('Shift.stop(running.id, "you halted it")');
    /*
     * About CODE, not about words. The first version of this asserted the
     * block did not contain "worktree" — and failed against the comment that
     * explains why no worktree is touched. A guard that a paragraph can break
     * is a guard that gets deleted.
     */
    const code = block.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).not.toContain("worktree");
    expect(code).not.toContain("discardRun");
    expect(code).not.toContain("runGitIn");
  });

  /*
   * The two that followed — unwinding newest first, and carrying on past a
   * failure — described a table of acts that never held a row. There is no
   * unwinding now: reversal is removing the worktree, and that is a decision
   * somebody makes after reading it.
   */
});

describe("seal: the only claim still unproven", () => {
  /*
   * NOT PROVEN, and it says so.
   *
   * A queue does not create a multi-step act to interrupt: each approved
   * proposal is one request that either happens or does not. Halting between
   * two of them is trivially true and proves nothing about halting DURING one.
   *
   * The claim stays `todo` until something takes more than one step. A green
   * tick for a test that has never run is the most expensive lie a safety panel
   * can tell.
   */
});
