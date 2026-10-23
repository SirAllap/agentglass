/*
 * Where the list of computers is wired in. There is no renderer in this
 * project, so a rule about a screen is asserted against its source — each
 * assertion was broken on purpose and watched go red before it was trusted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const provider = read("src/state/host-context.tsx");
const tabsLayout = read("app/(tabs)/_layout.tsx");
const rootLayout = read("app/_layout.tsx");
const pair = read("app/pair.tsx");

/** From `from` to the next `to` after it, or the test fails loudly. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("a computer that took this phone off its list", () => {
  const block = between(provider, "error === REVOKED", "const list = <T,>");
  test("is marked, never forgotten, so the others keep alerting", () => {
    // Broken on purpose: forgetHost() here drops the only record of what
    // happened, and setHost(null) sends a phone with four good computers to
    // the first-run screen.
    expect(block).toContain("markRevoked(");
    expect(block).not.toContain("forgetHost");
    expect(block).not.toContain("setHost(null)");
  });
  test("stops the service only when no usable computer is left", () => {
    expect(block).toMatch(/some\(\(h\) => !h\.revoked\)/);
    expect(block).toContain("syncKeepAlive(false)");
  });
  test("the socket is not opened for it", () => {
    expect(provider).toMatch(/if \(!host \|\| host\.revoked\) \{ setLive\("offline"\); return; \}/);
  });
});

describe("the provider", () => {
  test("hands out the list and the four things done to it", () => {
    for (const name of ["hosts", "switchTo", "rename", "forgetComputer"]) {
      expect(provider).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
  test("keeps the active host's identity across a rename or a switch of lastUsed", () => {
    // Broken on purpose: handing the list's own entry to the effects tears
    // the socket down and rebuilds it every time the owner renames a computer.
    expect(provider).toMatch(/useMemo\(\s*\(\) => active,/);
  });
  test("leaving a computer drops its data, its cache and its colours", () => {
    const leave = between(provider, "const leave = useCallback(", "const forgetComputer");
    expect(leave).toContain("setFleet(EMPTY)");
    expect(leave).toContain("setDeskTheme(null)");
    expect(leave).toContain("forgetCachedAsks()");
    expect(leave).toContain("generation.current++");
  });
  test("switching persists the choice, then leaves", () => {
    const sw = between(provider, "switchTo: async", "rename: async");
    expect(sw).toContain("setActive(");
    expect(sw).toContain("leave()");
  });
  test("forgetting the one in use leaves; forgetting another does not", () => {
    const f = between(provider, "const forgetComputer = useCallback(", "}, [leave, commit]);");
    expect(f).toContain("removeHost(");
    expect(f).toMatch(/if \(after\.active !== activeId\.current\) leave\(\);/);
  });
});

describe("the chip is on all four destinations", () => {
  test("pull requests, issues and cards take it from the shared header", () => {
    expect(tabsLayout).toContain("ComputerChip");
    expect(tabsLayout).toMatch(/headerTitle: \(\) => <ComputerChip/);
    for (const name of ["prs", "issues", "tasks"]) {
      expect(tabsLayout).toMatch(new RegExp(`name="${name}" options=\\{\\{[^}]*\\.\\.\\.destination`));
    }
  });
  test("the terminal draws it in its own header", () => {
    expect(read("app/(tabs)/terminal.tsx")).toContain("<ComputerChip");
  });
});

describe("pairing a second computer", () => {
  test("the root no longer sends a paired phone off the pairing screen", () => {
    // Broken on purpose: with the old `host && onPairing` redirect, tapping
    // Add on the switcher bounces straight back to the tabs.
    expect(rootLayout).not.toMatch(/host && onPairing/);
  });
  test("the pairing screen leaves for the tabs itself once it is paired", () => {
    expect(pair).toMatch(/await pair\(host[^)]*\);\s*router\.replace\("\/"\)/);
  });
  test("it can be left with Back only when there is somewhere to go back to", () => {
    expect(pair).toMatch(/hosts\.length > 0/);
  });
  test("the address is asked for only when the field holds a bare ticket", () => {
    expect(pair).toContain("needsAddress(");
  });
});

describe("the switcher", () => {
  const chip = read("src/nav/ComputerChip.tsx");
  const sheet = read("src/nav/ComputerSheet.tsx");
  test("the chip opens the one sheet", () => {
    expect(chip).toContain("<ComputerSheet");
  });
  test("one tap on a row switches and closes", () => {
    expect(sheet).toMatch(/switchTo\(/);
    expect(sheet).toMatch(/onClose\(\)/);
  });
  test("forgetting says who you land on, and renaming goes through the provider", () => {
    expect(sheet).toContain("forgetNote(");
    expect(sheet).toContain("forgetComputer(");
    expect(sheet).toContain("rename(");
  });
  test("Add is refused at the cap, with a line that says so", () => {
    expect(sheet).toContain("capReached(");
  });
});

describe("what hangs off one computer is keyed by it", () => {
  test("viewed ticks and recents carry the computer's id", () => {
    // Broken on purpose: two computers both have /home/x/orbit, and a tick
    // made on one showed as read on the other.
    expect(read("app/git-commit.tsx")).toMatch(/viewedKey\(host\?\.id/);
    expect(read("app/git-diff.tsx")).toMatch(/viewedKey\(host\?\.id/);
    expect(read("app/files.tsx")).toMatch(/useRecents\(computerKey\(host/);
  });
  test("the talk counters are fed by the computer in front only", () => {
    // A second socket (S3) must not bump a pull request's counter that another
    // computer's screen is open on: noteTalk/noteChecks stay behind a check of
    // which socket the frame came from.
    expect(provider).toMatch(/noteTalk\(note\)/);
  });
});

describe("the four destinations say why there is nothing to show", () => {
  for (const [file, label] of [
    ["app/(tabs)/terminal.tsx", "terminal"],
    ["app/(tabs)/prs.tsx", "prs"],
    ["app/(tabs)/issues.tsx", "issues"],
    ["app/(tabs)/tasks.tsx", "tasks"],
  ] as const) {
    test(`${label} shows the removed/offline card instead of an empty list`, () => {
      expect(read(file)).toContain("<ComputerGone");
    });
  }
});
