/*
 * The ledger of who last wrote to a shared volume.
 *
 * Everything here is about not lying. The ledger's whole value is that it
 * answers "is the bundle my app is serving mine?" — and an answer that is
 * confidently wrong is worse than no answer at all, because the wrong one gets
 * believed and the missing one gets checked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setLedgerPath, forget, ledgerAll, ledgerFor, noteWrite } from "../src/dockerledger.ts";

const dirs: string[] = [];
function ledgerAt(): string {
  const d = mkdtempSync(join(tmpdir(), "agx-ledger-"));
  dirs.push(d);
  const p = join(d, "docker-owners.json");
  __setLedgerPath(p);
  return p;
}
afterEach(() => {
  __setLedgerPath(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (over: Partial<Parameters<typeof noteWrite>[1]> = {}) => ({
  worktree: "orbit-1042", branch: "ORBIT-1042-caller-id", at: "2026-08-19T09:00:00.000Z", via: "install-app-keypad", ...over,
});

describe("recording a write", () => {
  test("a volume remembers who finished writing to it", () => {
    ledgerAt();
    noteWrite(["frontend"], write());
    expect(ledgerFor("frontend")?.last).toMatchObject({ worktree: "orbit-1042", via: "install-app-keypad" });
  });

  test("one container can write several volumes", () => {
    ledgerAt();
    noteWrite(["frontend", "pnpm-store"], write());
    expect(ledgerFor("pnpm-store")?.last?.worktree).toBe("orbit-1042");
  });

  /* This is the line that turns a name into "shared by six worktrees", which is
     the fact nothing else on the machine reports. */
  test("every checkout that has written is remembered, newest first", () => {
    ledgerAt();
    noteWrite(["frontend"], write({ worktree: "orbit-1042" }));
    noteWrite(["frontend"], write({ worktree: "orbit-2210", at: "2026-08-19T10:00:00.000Z" }));
    noteWrite(["frontend"], write({ worktree: "orbit-1042", at: "2026-08-19T11:00:00.000Z" }));
    expect(ledgerFor("frontend")?.seen).toEqual(["orbit-1042", "orbit-2210"]);
  });

  test("nothing observed is null, not a guess", () => {
    ledgerAt();
    expect(ledgerFor("never-seen")).toBe(null);
  });
});

describe("two agentglass instances", () => {
  /* A phone session and a desktop window watch the same daemon. The one that
     writes second must not overwrite a newer observation with its older one. */
  test("an older observation never replaces a newer one", () => {
    const p = ledgerAt();
    noteWrite(["frontend"], write({ worktree: "orbit-2210", at: "2026-08-19T12:00:00.000Z" }));
    // Somebody else's process, writing straight to the file, sees the world at
    // 12:00 too — and then we record something we observed at 09:00.
    noteWrite(["frontend"], write({ worktree: "orbit-1042", at: "2026-08-19T09:00:00.000Z" }));
    expect(ledgerFor("frontend")?.last?.worktree).toBe("orbit-2210");
    expect(JSON.parse(readFileSync(p, "utf8")).frontend.last.worktree).toBe("orbit-2210");
  });

  test("and a write from another process is picked up rather than clobbered", () => {
    const p = ledgerAt();
    noteWrite(["a"], write());
    // The other instance recorded a volume this one has never heard of.
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    onDisk["b"] = { last: write({ worktree: "orbit-landing", at: "2026-08-19T13:00:00.000Z" }), seen: ["orbit-landing"] };
    writeFileSync(p, JSON.stringify(onDisk));

    noteWrite(["c"], write());
    expect(Object.keys(ledgerAll()).sort()).toEqual(["a", "b", "c"]);
    expect(ledgerFor("b")?.last?.worktree).toBe("orbit-landing");
  });
});

describe("staying honest", () => {
  /* A record that outlives its volume is a lie with a date on it: the name gets
     reused by a fresh `docker volume create` and the panel confidently names a
     worktree that never touched it. */
  test("a volume that no longer exists is forgotten", () => {
    ledgerAt();
    noteWrite(["frontend", "keypad-node-modules"], write());
    forget(["keypad-node-modules"]);
    expect(ledgerFor("keypad-node-modules")).toBe(null);
    expect(ledgerFor("frontend")).not.toBe(null);
  });

  test("a corrupt file reads as empty instead of throwing", () => {
    const p = ledgerAt();
    writeFileSync(p, "{not json");
    expect(ledgerAll()).toEqual({});
    // And it repairs itself with the next observation.
    noteWrite(["frontend"], write());
    expect(ledgerFor("frontend")?.last?.worktree).toBe("orbit-1042");
  });

  test("writing to a place that cannot be written does not take the server down", () => {
    __setLedgerPath("/proc/definitely/not/writable/ledger.json");
    expect(() => noteWrite(["frontend"], write())).not.toThrow();
    // It still answers for this session, which is all that was promised.
    expect(ledgerFor("frontend")?.last?.worktree).toBe("orbit-1042");
  });

  test("the file is not world-readable", () => {
    const p = ledgerAt();
    noteWrite(["frontend"], write());
    // It carries branch names, which are ticket numbers, which are somebody's
    // work. 0600 like the token and devices files.
    expect(require("node:fs").statSync(p).mode & 0o077).toBe(0);
  });
});
