/*
 * "Tell me when…" is a write, and a phone paired to look only is told so.
 *
 * The row states the rule it follows: a phone that may not act on a row still
 * sees it, with the reason in one line, rather than a button that posts into a
 * 403. The watch link was the one control drawn regardless of the pairing, and
 * the sheet behind it posted three routes without asking. Both are asserted
 * against source, because what is being pinned is where the gate sits.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WHY_NOT } from "../src/model/inbox.ts";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

describe("the reason", () => {
  test("is one line, and says what to do about it", () => {
    expect(WHY_NOT.watch).toContain("pair");
    expect(WHY_NOT.watch.toLowerCase()).toContain("look only");
  });
});

describe("the link on a row", () => {
  const row = src("src", "inbox", "InboxRow.tsx");

  test("is drawn for a phone that may not write too, and the row still says why", () => {
    expect(row).toContain('const mayWrite = host.scope === "full"');
    // The sheet opens read-only rather than not at all: the mock's read-only
    // state is reading the rules with this pairing. The link is not gated on
    // the scope, and the row carries the reason one line down.
    const link = "{pr && pr.repo ? <WatchLink onPress={() => onWatch(pr)} /> : null}";
    expect(row.split(link).length - 1).toBe(2);
    expect(row).toContain("{WHY_NOT.watch}");
  });
});

describe("the sheet behind it", () => {
  const sheet = src("src", "inbox", "WatchRuleSheet.tsx");

  test("is handed the pairing, and Done is off without it", () => {
    expect(sheet).toContain("mayWrite: boolean;");
    expect(sheet).toContain("disabled={!pr || !draft || !mayWrite}");
    expect(sheet).toContain("if (!mayWrite) return;");
  });

  test("is opened with the same reading of the pairing as the row", () => {
    expect(src("src", "inbox", "InboxList.tsx")).toContain('mayWrite={host.scope === "full"}');
  });

  test("shows the rules as they are when the pairing cannot write", () => {
    // The switches are shown, not offered: no second way to set them.
    expect(sheet).toContain("disabled={!mayWrite}");
    expect(sheet).toContain("You can see the rules, not change them");
    expect(sheet).toContain("Set to read-only on the computer");
  });
});
