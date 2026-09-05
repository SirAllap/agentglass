/*
 * Turning a container's exit into a line in the ledger.
 *
 * The transport is a `docker events` process and is not what breaks. What
 * breaks is the reading: a read-only mount counted as a write claims ownership
 * of a volume the container never touched, and a missing checkout label turned
 * into a guess names the wrong worktree — which is precisely the confusion the
 * ledger exists to end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setLedgerPath, ledgerFor } from "../src/dockerledger.ts";
import { __resetBranchCacheForTest } from "../src/dockerowner.ts";
import { exitFacts, recordExit } from "../src/dockerwatch.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agx-watch-")); dirs.push(d); return d; };
afterEach(() => {
  __setLedgerPath(null);
  __resetBranchCacheForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const inspect = (over: Record<string, unknown> = {}) => JSON.stringify([{
  Name: "/orbit-install-keypad-run-a1b2",
  Config: {
    Labels: {
      "com.docker.compose.project.working_dir": "/home/dev/code/orbit-1042/compose",
      "com.docker.compose.service": "install-app-keypad",
    },
  },
  Mounts: [
    { Type: "volume", Name: "frontend", RW: true, Destination: "/app/frontend/build" },
    { Type: "volume", Name: "pnpm-store", RW: false, Destination: "/store" },
    { Type: "bind", Source: "/home/dev/code/orbit-1042", Destination: "/project" },
  ],
  ...over,
}]);

describe("reading one container's exit", () => {
  test("read-write volumes only — a read-only mount is not a write", () => {
    expect(exitFacts(inspect())!.volumes).toEqual(["frontend"]);
  });

  test("binds are not volumes", () => {
    expect(exitFacts(inspect())!.volumes).not.toContain("/home/dev/code/orbit-1042");
  });

  test("the checkout comes from compose's own label", () => {
    expect(exitFacts(inspect())!.workingDir).toBe("/home/dev/code/orbit-1042/compose");
  });

  /* `install-app-keypad` says far more in a tooltip than a hex id, and it is
     the name somebody would recognise from the Makefile. */
  test("the service name is preferred over the container's own", () => {
    expect(exitFacts(inspect())!.name).toBe("install-app-keypad");
  });

  test("and falls back to the container name when there is no service", () => {
    expect(exitFacts(inspect({ Config: { Labels: {} } }))!.name).toBe("orbit-install-keypad-run-a1b2");
  });

  test("garbage is null, not a throw", () => {
    expect(exitFacts("not json")).toBe(null);
    expect(exitFacts("[]")).toBe(null);
  });
});

describe("recording it", () => {
  function ledgerHere() {
    const d = tmp();
    __setLedgerPath(join(d, "owners.json"));
  }

  test("the volume learns the worktree, the branch and what wrote it", () => {
    ledgerHere();
    const wt = tmp();
    mkdirSync(join(wt, "orbit-1042/.git"), { recursive: true });
    writeFileSync(join(wt, "orbit-1042/.git/HEAD"), "ref: refs/heads/ORBIT-1042-caller-id\n");
    const facts = exitFacts(inspect({
      Config: { Labels: { "com.docker.compose.project.working_dir": join(wt, "orbit-1042"), "com.docker.compose.service": "install-app-keypad" } },
    }))!;

    expect(recordExit(facts, () => new Date("2026-08-19T09:00:00Z"))).toBe(true);
    expect(ledgerFor("frontend")?.last).toMatchObject({
      worktree: "orbit-1042", branch: "ORBIT-1042-caller-id", via: "install-app-keypad", at: "2026-08-19T09:00:00.000Z",
    });
  });

  /* A `docker run` by hand has no compose label. The write happened, but nobody
     can be named for it — and naming the wrong checkout is worse than naming
     none, because the wrong one gets believed. */
  test("no checkout label means nothing is recorded", () => {
    ledgerHere();
    const facts = exitFacts(inspect({ Config: { Labels: {} } }))!;
    expect(recordExit(facts)).toBe(false);
    expect(ledgerFor("frontend")).toBe(null);
  });

  test("a container that wrote no volumes records nothing", () => {
    ledgerHere();
    const facts = exitFacts(inspect({ Mounts: [] }))!;
    expect(recordExit(facts)).toBe(false);
  });

  test("an unreadable inspect records nothing", () => {
    ledgerHere();
    expect(recordExit(exitFacts("nonsense"))).toBe(false);
  });
});
