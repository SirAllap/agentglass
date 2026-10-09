/*
 * No credential, no reader: the card watcher asks ClickUp nothing.
 *
 * The watcher's timer is armed at boot for everybody, so a machine that never
 * connected ClickUp runs it every six minutes for as long as the server is up.
 * `pollCards` is where that has to end in silence, and until now nothing pinned
 * it: both watch suites inject an answer, so the branch with no credential was
 * never walked. This one stands up a fake ClickUp, points the client at it and
 * counts what arrives.
 *
 * The control matters as much as the claim. A counter that cannot see a request
 * would pass the whole file, so one test connects a token and expects to be
 * heard.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cuwatch-notoken-"));

const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const W = await import("../src/clickupwatch.ts");

let hits = 0;
const fake = Bun.serve({
  port: 0,
  fetch() { hits++; return Response.json({ tasks: [] }); },
});

beforeAll(() => {
  C.__setCredentialsPath(join(dir, "credentials.json"));
  CU.__setClickUpBase(`http://127.0.0.1:${fake.port}`);
  W.__setWatchPath(join(dir, "watch.json"));
  W.__resetTrouble();
});
afterAll(() => {
  fake.stop(true);
  C.__setCredentialsPath(null);
  CU.__setClickUpBase(null);
  W.__setWatchPath(null);
  W.__resetTrouble();
  rmSync(dir, { recursive: true, force: true });
});

describe("a machine without ClickUp", () => {
  it("polls to nothing and sends nothing, tick after tick", async () => {
    expect(C.hasCredential("clickup")).toBe(false);
    hits = 0;
    expect(await W.pollCards(1_000_000)).toEqual([]);
    expect(await W.pollCards(1_000_000 + W.WATCH_MS)).toEqual([]);
    expect(hits).toBe(0);
  });

  it("does not leave a trouble note behind either", async () => {
    // A poll that gave up for want of a token is not a failing integration; the
    // ClickUp row must not turn red for a service nobody connected.
    await W.pollCards(2_000_000);
    expect(W.cardWatchTrouble()).toBeNull();
  });

  it("control: with a token the same poll does reach the fake", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });
    hits = 0;
    await W.pollCards(3_000_000);
    expect(hits).toBeGreaterThan(0);
  });
});
