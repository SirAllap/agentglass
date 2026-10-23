/*
 * With no policy stored anywhere, `start --role` is the TUI under the role's
 * lock, exactly as before. Its own file and its own server because a policy,
 * once stored, cannot be taken back, and "nothing stored" is the precondition.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { roleLaunch, workerRole } from "../../shared/workerRoles.ts";
import { agentProvider } from "../../shared/agentKinds.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("wlegacy"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("a seat's role start with no policy stored", () => {
  test("is the TUI under the role's lock, and the row is the seat's", async () => {
    const r = await h.asSeat("/agents/named/start", { name: "legacy1", cwd: h.wt, role: "builder", keep: true });
    expect(r.ok).toBe(true);
    expect(r.result?.engine).toBeUndefined();
    const argv = await h.until(async () => readdirSync(h.logs).filter((n) => n.startsWith("tui-") && n.endsWith(".argv"))
      .map((n) => readFileSync(join(h.logs, n), "utf8").split("\0").filter(Boolean)).find((a) => a.includes("--settings") && a.includes("sonnet")));
    const want = roleLaunch(agentProvider("claude")!, workerRole("builder")!, "sonnet")!.args;
    expect(argv[argv.indexOf("--settings") + 1]).toBe(want[1]!);
    expect(argv).not.toContain("-p");
    const a = await h.row("legacy1");
    expect(a?.seatRoot).toBe(h.dir);
    expect(a?.startedBy).toBeUndefined();
    await h.asSeat("/agents/named/stop", { name: "legacy1" });
  }, 30_000);

  test("a worker of that kind can still report to its seat: the wall is for policy-started workers", async () => {
    expect((await h.asSeat("/agents/named/start", { name: "legacy2", cwd: h.wt, role: "builder", keep: true })).ok).toBe(true);
    const r = await h.asSeat("/seat/say", { root: h.dir, line: "still here" }, { "X-Agentglass-Agent": "legacy2" });
    expect(r.status).not.toBe(403);
    await h.asSeat("/agents/named/stop", { name: "legacy2" });
  }, 30_000);
});
