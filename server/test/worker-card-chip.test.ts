/*
 * A WORKER STARTED WITH --card CARRIES THAT CARD TO ITS WINDOW.
 *
 * `agentglass-agent start <name> --card ORBIT-1042` ran in the parent
 * checkout while the worker edited a worktree reached by absolute path, never
 * `cd`. The bar's own branch lookup (`namedWorktree`, paneWorktree.ts) needs
 * the card pinned on the window as `@agx-card` to tell that worktree from the
 * parent's — the pane's own cwd cannot, by design. `startAgent` took no card
 * at all, so every worker window opened with none, whatever `--card` said.
 */
import { describe, expect, test } from "bun:test";

describe("the card a start resolved reaches the window", () => {
  test("startAgent forwards it as engineWindowOutcome's cardId", async () => {
    const src = await Bun.file(new URL("../src/agentops.ts", import.meta.url)).text();
    expect(src).toContain("card?: string;");
    // Measured on the m40 run: the call now passes `into` (not agentSession(p.root)) and a trailing
    // placeFor(p.name, into) after the card, so the card is anchored by what precedes it only.
    expect(src).toMatch(/engineWindowOutcome\([^\n]*false, false, false, p\.card \?\? "", /);
  });

  test("a direct /agents/named/start passes the card it resolved (--card, or one named in the prompt)", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = src.indexOf("const r = await AgentOps.startAgent({");
    const block = src.slice(at, src.indexOf("});", at));
    expect(block).toContain("card: ask?.id,");
  });

  test("a start through the orchestration policy passes the card its brief resolved", async () => {
    const src = await Bun.file(new URL("../src/agents/policystart.ts", import.meta.url)).text();
    const at = src.indexOf("const r = await startGuarded({");
    const block = src.slice(at, src.indexOf("}, g.serve);", at));
    expect(block).toContain("card: p.cardRef?.id,");
  });
});
