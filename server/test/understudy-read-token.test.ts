/*
 * The credential the work loop hands its agent, and the hole it closed.
 *
 * He asked for the clone to have the views as well — the pull request panel,
 * the diff, the branch list. A view is pixels and a layout, which means nothing
 * to something with no screen; what a view IS underneath is a route. So it gets
 * the routes.
 *
 * FINDING OUT HOW TO GIVE IT THEM EXPOSED THE HOLE. The agent inherits the
 * process environment, and that environment carries `AGENTGLASS_TOKEN` — the
 * machine token, `full` scope, every write route in the application open to it.
 * So an agent that thought to curl its own server could have pushed a branch,
 * merged a pull request or written to the task tracker, and the careful wording
 * in its brief was the only thing in the way.
 *
 * Worse, `understudyAllows` had fenced this principal since the day it was
 * written and NOTHING COULD PRESENT IT: `callerFor` returned a machine or a
 * device and nothing else. The fence guarded a caller with no way to arrive,
 * while the thing it was meant to fence held the machine key.
 *
 * One minted credential answers both: every view readable, every write refused.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let AUTH: typeof import("../src/auth.ts");

const MACHINE = "the-machine-token";
const req = (t: string) => new Request("http://127.0.0.1:4000/x", { headers: { authorization: `Bearer ${t}` } });
const url = new URL("http://127.0.0.1:4000/x");

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), "agx-rt-"));
  mkdirSync(join(d, "config", "git"), { recursive: true });
  writeFileSync(join(d, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(d, "t.db");
  process.env.XDG_CONFIG_HOME = join(d, "config");
  AUTH = await import("../src/auth.ts");
});

describe("a minted credential carries the understudy's principal", () => {
  test("it is recognised, and it is not the machine", () => {
    const t = AUTH.mintUnderstudyToken();
    const caller = AUTH.callerFor(req(t), url, MACHINE);
    expect(caller?.principal).toBe("understudy");
    // The machine token still identifies the machine, unchanged.
    expect(AUTH.callerFor(req(MACHINE), url, MACHINE)?.principal).toBeUndefined();
    AUTH.revokeUnderstudyToken(t);
  });

  test("revoking it makes it useless immediately", () => {
    const t = AUTH.mintUnderstudyToken();
    expect(AUTH.callerFor(req(t), url, MACHINE)).toBeTruthy();
    AUTH.revokeUnderstudyToken(t);
    // Not "expired" — gone. A credential that lingers after the work it was
    // minted for is one somebody finds later.
    expect(AUTH.callerFor(req(t), url, MACHINE)).toBeNull();
  });

  test("they do not accumulate across runs", () => {
    const before = AUTH.understudyTokenCount();
    const a = AUTH.mintUnderstudyToken();
    const b = AUTH.mintUnderstudyToken();
    expect(AUTH.understudyTokenCount()).toBe(before + 2);
    AUTH.revokeUnderstudyToken(a);
    AUTH.revokeUnderstudyToken(b);
    expect(AUTH.understudyTokenCount()).toBe(before);
  });
});

describe("it can see every view and change nothing", () => {
  const clone = { kind: "machine" as const, scope: "full" as const, principal: "understudy" as const };

  test("the views he looks at are readable", () => {
    /*
     * Named individually rather than "GET is allowed", because these are the
     * ask: the panel, the diff, the branches, the history. If one of them ever
     * needs `full`, this test says so rather than the agent finding out.
     */
    for (const route of [
      "/prs/list", "/git/changes-all", "/git/branches", "/git/log",
      "/git/worktrees", "/understudy/ask", "/understudy/scorecard",
    ]) {
      expect(AUTH.allowed(clone, "GET", route), `${route} should be readable`).toBe(true);
    }
  });

  test("and every route that changes something is refused", () => {
    // The half that matters. Before the minted credential the agent held the
    // machine token, and every one of these would have answered yes.
    for (const route of [
      "/git/push", "/git/commit", "/git/merge", "/git/branch-delete",
      "/prs/merge", "/prs/comment", "/prs/review", "/clickup/task", "/clickup/comment",
      "/chat/send", "/terminal/tmux/windows", "/gate/decide",
    ]) {
      expect(AUTH.allowed(clone, "POST", route), `${route} must be refused`).toBe(false);
    }
  });

  test("the agent is handed the minted token, not the machine one", async () => {
    /*
     * The whole point, asserted where it is decided. `env: { ...process.env }`
     * on its own carries the machine token straight through — the override has
     * to be there, and it has to be a mint rather than a copy.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    /*
     * The open paren matters. `runAgentInPane` was added above this function
     * and shares its first twenty-four characters, so a prefix search silently
     * started reading the WRONG function — and the assertions below still made
     * sense there, which is how four tests failed for one cause.
     */
    const from = src.indexOf("async function runAgentIn(");
    /*
     * To the end of the function, not a fixed number of characters. The count
     * was 2200, and adding a comment inside the function pushed the `finally`
     * past it — so the test failed because the code got better documented,
     * which teaches everyone to distrust it.
     */
    const close = src.indexOf("\n}\n", from);
    const block = src.slice(from, close === -1 ? from + 4000 : close);
    expect(block).toContain("mintUnderstudyToken()");
    expect(block).toContain("AGENTGLASS_TOKEN: readToken");
    // And revoked in `finally`, so a run that throws or times out leaves
    // nothing live behind.
    expect(block).toContain("revokeUnderstudyToken(readToken)");
    expect(block).toContain("} finally {");
  });
});
