/*
 * The Integrations page has to answer before you have finished reading it.
 *
 * It used to take 10.7 seconds cold, measured on a real machine — 10.3 of them
 * ClickUp, whose list query has a ten-to-twelve second floor of its own (see
 * fetchTasks), and the other four hundred milliseconds everything else. Two
 * things were wrong at once: the four providers were asked in a loop, so the
 * page cost the SUM of their answers, and the ClickUp probe filled a cache it
 * did not need in order to say whether a token works.
 *
 * So the rule this file defends is: reading a status never goes to the network.
 * The stub below fails the test by being CALLED, which is the only way to catch
 * a regression whose symptom is ten seconds of nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pf-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const P = await import("../src/providers.ts");
const W = await import("../src/clickupwatch.ts");

let calls = 0;
const server = Bun.serve({
  port: 0,
  fetch() {
    calls++;
    return new Response(JSON.stringify({ tasks: [] }), {
      headers: { "content-type": "application/json" },
    });
  },
});

beforeEach(() => {
  calls = 0;
  C.__setCredentialsPath(join(dir, "creds.json"));
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__reset();
  // The card watch latches a failure in module state, and the ClickUp row now
  // reads it. Left over from one test it would decide another one's verdict.
  W.__setWatchPath(join(dir, "watch.json"));
  W.__resetTrouble();
});

afterEach(() => {
  W.__setCardReader(null);
  W.__setWatchPath(null);
  W.__resetTrouble();
});

afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("what a status probe is allowed to cost", () => {
  it("asks ClickUp for nothing when its cache is cold", () => {
    expect(CU.clickupCached()).toBeNull();
    expect(calls).toBe(0);
  });

  it("says the token is connected without waiting for the task count", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    const rows = await P.providerStatuses();
    const cu = rows.find((r) => r.id === "clickup")!;

    // Connected is the answer to the question this page asks. The count is a
    // detail, and it is the detail that costs ten seconds.
    expect(cu.state).toBe("connected");
    expect(cu.detail).toContain("Ada");
    expect(calls).toBe(0);
  });

  it("marks that answer pending, so the page knows to come back for the rest", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    const cu = (await P.providerStatuses()).find((r) => r.id === "clickup")!;

    // A flag rather than a "…" in the prose: the page reads this to decide
    // whether to poll again, and prose gets edited.
    expect(cu.pending).toBe(true);
  });

  it("stops saying pending once the count is in", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    await CU.clickupTasks(true); // what the /providers handler kicks off behind its answer
    const cu = (await P.providerStatuses()).find((r) => r.id === "clickup")!;

    expect(cu.pending).toBeFalsy();
    expect(cu.detail).toContain("task");
  });

  it("still answers while the card watch is broken, and says so", async () => {
    /*
     * ClickUp is TWO features behind one token — the task list, cached, and the
     * card bell, polled every three minutes by clickupwatch.ts — and they fail
     * separately. The row could read "Connected · 13 tasks assigned to you"
     * from a snapshot taken before the token was rotated while every
     * notification since had been a silent 401 (T27). An unauthorised WATCH is
     * the token being refused, whatever the cached list still says, so it takes
     * the verdict; anything softer is a notice beside it.
     */
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    W.__setCardReader(async () => ({ ok: false, unauthorised: true, error: "ClickUp refused this token" }));
    await W.pollCards(1_000_000);

    const cu = (await P.providerStatuses()).find((r) => r.id === "clickup")!;
    expect(cu.state).toBe("error");
    expect(cu.detail).toContain("connect again");
    expect(cu.notice).toContain("Card notifications");
    expect(calls).toBe(0); // and it still costs no network, which is this file's rule
  });

  it("keeps a soft watch failure beside the verdict rather than instead of it", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    W.__setCardReader(async () => ({ ok: false, error: "Could not reach ClickUp" }));
    await W.pollCards(1_000_000);

    const cu = (await P.providerStatuses()).find((r) => r.id === "clickup")!;
    // A connected token whose bell is temporarily unreachable is still
    // connected. A red row here would send somebody to reconnect a good token.
    expect(cu.state).toBe("connected");
    expect(cu.notice).toContain("Card notifications are not getting through");
  });

  it("asks all four at once rather than one after another", async () => {
    // The loop version cost the sum. Asserted on the source because the thing
    // that went wrong is a shape, and a timing assertion on four probes that
    // are milliseconds apart on a fast machine is a flake waiting to happen.
    const src = await Bun.file(new URL("../src/providers.ts", import.meta.url)).text();
    expect(src).toContain("Promise.all(PROVIDERS.map(");
    expect(src).not.toMatch(/for \(const p of PROVIDERS\)/);
  });
});
