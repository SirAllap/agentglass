/*
 * The read-only credential is the fence. It must not sit next to the real one.
 *
 * The agent is handed a minted token through tmux `-e`: every GET answers,
 * every write refuses. That override works — measured, the variable inside its
 * window is the minted one — and it is what makes handing an agent bash and
 * every tool defensible at all.
 *
 * But a tmux SERVER carries the environment it was started with, and this one
 * was started by an application that has `AGENTGLASS_TOKEN` in its own — the
 * machine token, with every write route open to it. The agent has bash, and
 * tmux will hand out its global environment to anyone on the socket who asks
 * for a variable by name.
 *
 * Verified against the live engine, which returned the machine token. The
 * careful `-e` was guarding a window while the door beside it stood open.
 *
 * This file only READS source. It never starts a tmux, which is why it carries
 * no isolation of its own — see tmux-test-isolation.test.ts for why any file
 * that does start one must.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const runner = src.slice(src.indexOf("async function runAgentInPane("),
  src.indexOf("\nasync function runAgentIn("));

describe("the machine token is not reachable from the agent's pane", () => {
  test("it is unset from the engine's global environment", () => {
    const code = runner.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain('"set-environment", "-g", "-u", "AGENTGLASS_TOKEN"');
  });

  test("before the window is opened, not after", () => {
    /*
     * Order is the whole thing. Unsetting it after the agent has started is a
     * race with the first command it runs, and the first thing an agent does
     * is look around.
     */
    const code = runner.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    const unset = code.indexOf("set-environment");
    const opened = code.indexOf("engineWindowRunning(");
    expect(unset).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(-1);
    expect(unset, "unset must come first").toBeLessThan(opened);
  });

  test("and the minted one is still handed over explicitly", () => {
    // Removing the inherited token must not remove the credential the agent
    // is meant to have: it reaches the window through `-e`, not by inheritance.
    const caller = src.slice(src.indexOf("async function runAgentIn("),
      src.indexOf("\n}\n", src.indexOf("async function runAgentIn(")));
    expect(caller).toContain("AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken }");
    /*
     * AND THE FENCE DOES NOT EAT IT. The run's env also carries the
     * no-credentials fence (understudy-runenv.ts). Spread first, tokens last:
     * the other order would have the fence overwrite the one credential the
     * agent is supposed to hold, and the run would fail as "no token" — a
     * fence that shuts the door it was told to leave open.
     */
    const fence = caller.indexOf("...fenced");
    expect(fence, "the ladder stopped being fenced").toBeGreaterThan(-1);
    expect(caller.indexOf("AGENTGLASS_TOKEN: readToken"), "the fence must not come after the token")
      .toBeGreaterThan(fence);
  });

  test("the credential it gets cannot write", async () => {
    /*
     * The other half, and the reason the first half matters: the minted token
     * carries the understudy's principal, and that principal may reach exactly
     * two routes.
     */
    const auth = await Bun.file(new URL("../src/auth.ts", import.meta.url)).text();
    expect(auth).toContain("mintUnderstudyToken");
    const allow = await Bun.file(new URL("../src/understudy-allow.ts", import.meta.url)).text()
      .catch(() => auth);
    expect(allow.includes("/understudy/halt") || auth.includes("/understudy/halt")).toBe(true);
  });
});
