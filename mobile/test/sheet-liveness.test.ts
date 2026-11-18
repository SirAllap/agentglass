/*
 * A sheet that was dismissed mid-flight stops writing.
 *
 * Both sheets walk a list of writes with an `await` per item and no way back
 * once the first one is out: dismissing a lane sync with the scrim still moved
 * branches 2..5, and dismissing "Tell me when…" still armed the rest of the
 * rules and reloaded a screen nobody was looking at. The person's last action
 * was "close this".
 *
 * The read in each file already drops its answer when the sheet closes; these
 * are the writes catching up. Asserted against source, because there is no
 * renderer and the thing being pinned is the shape of the loop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const count = (text: string, what: string): number => text.split(what).length - 1;

describe("the lane sync", () => {
  const sheet = strip(src("src", "review", "SyncSheet.tsx"));
  const at = sheet.indexOf("const sync = useCallback(async (): Promise<void> => {");
  const sync = sheet.slice(at, sheet.indexOf("}, [host, mayWrite, rows, root, base, onDone]);", at));

  test("is dropped when the sheet closes, and every branch checks", () => {
    expect(at).toBeGreaterThan(-1);
    expect(sheet).toContain("live.current = open");
    expect(count(sync, "if (!live.current) return;")).toBeGreaterThanOrEqual(2);
  });

  test("does not finish — reload a board nobody is looking at — after a close", () => {
    const done = sync.slice(sync.indexOf("setPhase(\"done\")") - 80);
    expect(done).toContain("if (!live.current) return;");
    expect(done).toContain("onDone()");
  });
});

describe("the watch rules", () => {
  const sheet = strip(src("src", "inbox", "WatchRuleSheet.tsx"));
  const at = sheet.indexOf("const done = async (): Promise<void> => {");
  const done = sheet.slice(at, sheet.indexOf("\n  };", at));

  test("stop arming when the sheet closes", () => {
    expect(at).toBeGreaterThan(-1);
    expect(sheet).toContain("alive.current = open");
    expect(count(done, "if (!alive.current) return;")).toBeGreaterThanOrEqual(3);
  });

  test("and a partly landed write reads what the computer holds now", () => {
    // The list under the switches said what was armed BEFORE the press.
    expect(done).toContain("readArmed(host, pr)");
    expect(done).toContain("setWatches(again.watches)");
  });

  test("a reopen is not left with Done spinning from the closed one", () => {
    expect(sheet).toContain("setBusy(false)");
    const open = sheet.slice(sheet.indexOf("if (!open || !pr) return;"));
    expect(open.slice(0, open.indexOf("void (async"))).toContain("setBusy(false)");
  });
});
