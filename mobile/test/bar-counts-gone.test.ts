/*
 * The bar draws no numbers, and the bell draws the one that is left.
 *
 * The rule is the screen's, not a model's: it is about where a count is drawn,
 * so it is asserted against the source that draws it. Two files, because the
 * failure is a number that reappears in one of them:
 *
 *   - src/nav/TabBar.tsx: no badge, no count, no label with a quantity. The
 *     old bar carried gates and reviews, computed from its own two lists; the
 *     bell counts the Inbox's rows. Two answers to one question disagree the
 *     first time a list changes, and the one a person believes is whichever
 *     they looked at first.
 *   - src/nav/InboxBell.tsx: one bell, opening /inbox, with the count from the
 *     same hook the screen reads.
 *   - app/(tabs)/_layout.tsx and app/(tabs)/terminal.tsx: both headers mount
 *     that one bell, because the terminal draws its own header and is exactly
 *     where somebody wants to know something is waiting.
 */
import { describe, expect, test } from "bun:test";

const bar = await Bun.file(new URL("../src/nav/TabBar.tsx", import.meta.url)).text();
const layout = await Bun.file(new URL("../app/(tabs)/_layout.tsx", import.meta.url)).text();
const bell = await Bun.file(new URL("../src/nav/InboxBell.tsx", import.meta.url)).text();
const terminal = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text();

/** Code only: the comments here explain the numbers they no longer draw. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the bar", () => {
  const source = code(bar);

  test("draws no number of its own", () => {
    expect(source).not.toContain("counts");
    expect(source).not.toContain("99+");
    expect(source).not.toContain("waiting on you");
    expect(source).not.toContain("minWidth: 16");
  });

  test("names each destination and nothing else", () => {
    // The accessibility label used to say "Terminal, 2 waiting on you" while the
    // visible number said something else after a failed read.
    expect(source).toContain("accessibilityLabel={dest.label}");
  });

  test("is drawn from BAR rather than a second list", () => {
    expect(source).toMatch(/\{BAR\.map\(/);
  });
});

describe("the bell", () => {
  const source = code(bell);

  test("is in the shared header, between the usage chip and the gear", () => {
    expect(layout).toMatch(/<UsageChip \/>\s*<InboxBell \/>\s*<HeaderButton label="Settings"/);
  });

  test("the terminal's own header mounts the same bell", () => {
    // Two mounts of one component, not two drawings: the terminal is the
    // destination somebody sits in while things queue up.
    expect(terminal).toMatch(/<UsageChip colors=\{K\} \/>\s*<InboxBell colors=\{K\} \/>/);
  });

  test("opens the Inbox", () => {
    expect(source).toContain('router.push("/inbox")');
  });

  test("carries the count from the Inbox's own list", () => {
    // Not a length found here: the same hook the screen reads, so the number
    // and the rows above it are one list.
    expect(source).toContain("useInbox(host, fleet)");
    expect(source).toContain("Inbox, ${count} waiting");
  });

  test("says nothing when nothing is waiting", () => {
    expect(source).toContain('count > 0 ? `Inbox, ${count} waiting` : "Inbox"');
  });
});
