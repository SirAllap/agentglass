/*
 * The bottom of the terminal, drawn the way the approved mock draws it.
 *
 * Three things live there and each of them was a different shape from the
 * drawing: the key bar (unbordered keys in the catalogue's old order, with the
 * grid key as a filled box), the composer (send inside the capsule, as a fifth
 * equal target), and the strip above it (underlined tabs with the state word
 * spelled out under each name).
 *
 * ── why a source scan and not a render ───────────────────────────────────
 * The same reason tap-floor.test.ts scans source: there is no renderer in this
 * project to mount the terminal in, and every property here is a number or a
 * shape written in a style object. What a screenshot proves is the screens that
 * exist today; this is what stops the fourth shape from being written.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const screen = readFileSync(new URL("../app/(tabs)/terminal.tsx", import.meta.url), "utf8");

/** The key bar: from the row that holds the keys to the composer under it. */
const keyBar = screen.slice(
  screen.indexOf("flexDirection: \"row\", alignItems: \"center\", height: TAP + SPACE.sm"),
  screen.indexOf("flexDirection: \"row\", alignItems: \"center\", gap: SPACE.sm, paddingHorizontal: SPACE.md"),
);

/** The composer: from the row that holds the field to the end of the tab. */
const composer = screen.slice(
  screen.indexOf("flexDirection: \"row\", alignItems: \"center\", gap: SPACE.sm, paddingHorizontal: SPACE.md"),
  screen.indexOf("</ComputerGone>"),
);

/** What sits between two markers, so an assertion is about one part of the row. */
const between = (from: string, to: string): string => {
  const a = composer.indexOf(from);
  const b = composer.indexOf(to);
  expect(a, `${from} is gone from the composer`).toBeGreaterThan(-1);
  expect(b, `${to} is gone from the composer`).toBeGreaterThan(a);
  return composer.slice(a, b);
};

describe("the key bar", () => {
  test("every key wears the same hairline and the ladder's control corner", () => {
    // A key is a thing you press, not a label: an unbordered key on the bar's
    // own ground read as five words in a row.
    expect(screen).toMatch(/borderWidth: latch === "locked" \? 2 : 1,/);
    expect(screen).toMatch(/borderRadius: RADIUS\.md,/);
    // A hairline at the raised edge's rung, not the bar's own rule: a key drawn
    // in the row's border colour is a key with no edge at all.
    expect(screen).toMatch(/borderColor: latch !== "off" \? K\.primary : K\.border2,/);
  });

  test("a key's face is the card, and the bar is the ground under it", () => {
    // `bg3` was the inset — a key drawn in the colour of a pressed one. The
    // mock puts the card on the page and lets the hairline do the lifting.
    expect(screen).toMatch(/backgroundColor: latch !== "off" \? K\.primary : pressed \? K\.bg4 : K\.bg2,/);
    expect(screen).toMatch(/borderTopWidth: 1, borderTopColor: K\.border, backgroundColor: K\.bg \}/);
  });

  test("a press sinks the key", () => {
    // The drawing scales the key on press. A grey swap alone was a key that
    // flickered rather than one that was pressed.
    expect(screen).toMatch(/transform: \[\{ scale: pressed \? 0\.94 : 1 \}\],/);
  });

  test("an armed latch is filled with the accent, and a locked one is outlined", () => {
    // Two states that have to look unlike each other: armed sends on the next
    // key, locked stays until it is tapped off.
    expect(screen).toMatch(/backgroundColor: latch !== "off" \? K\.primary : pressed \? K\.bg4 : K\.bg2,/);
    expect(screen).toMatch(/color: latch !== "off" \? ink\(K\.primary\) : K\.text2,/);
  });

  test("the grid key is a key, not a filled panel", () => {
    // The mock's ⋮ is the same hairline square as the keys beside it, with a
    // grid on it. Three dots in a filled box read as "more of this screen".
    expect(screen).toMatch(/<Glyph name="grid" color=\{K\.text2\} size=\{20\} \/>/);
    expect(screen).not.toMatch(/<Glyph name="more" color=\{K\.text2\} size=\{22\} \/>/);
  });

  test("searching the scrollback is one tap from the keys", () => {
    // It was two taps deep in the ··· sheet, and it is the one thing on this
    // row somebody reaches for while reading output. The approved mock draws it
    // and `⋮` as the strip's last two keys, so both scroll with the keys rather
    // than sitting pinned beside them.
    expect(screen).toMatch(/accessibilityLabel="Search the scrollback"\s*\n\s*style=\{\(\{ pressed \}\) => \(\{/);
    expect(screen).toMatch(/onPress=\{openFind\}/);
    const at = keyBar.indexOf('accessibilityLabel="Search the scrollback"');
    const scrollerEnd = keyBar.indexOf("</ScrollView>");
    expect(scrollerEnd, "the key bar has no scroller").toBeGreaterThan(-1);
    expect(at, "search is not on the row of keys").toBeGreaterThan(-1);
    expect(at, "search must be inside the row that scrolls").toBeLessThan(scrollerEnd);
    // And before `⋮`, which is the row's last key.
    expect(at).toBeLessThan(keyBar.indexOf('accessibilityLabel="All keys"'));
  });
});

describe("the composer", () => {
  test("send is its own circle, outside the capsule", () => {
    /*
     * The one filled control on the row, because it is the only one that ends
     * the line — and a target that sends a command must not be drawn as a
     * fifth of a capsule. The capsule closes after the microphone and before
     * send; inside it, there is no `</View>` between the two.
     */
    const capsuleEnds = between('accessibilityLabel={hearing === "listening"', 'accessibilityLabel={raw ? "Enter"');
    expect(capsuleEnds).toMatch(/<\/View>/);
  });

  test("send is drawn, not typed", () => {
    // The character `↑` is missing from some Android fonts, and the mock draws
    // the arrow as a stroke. `keys.test.ts`'s reason, one glyph over.
    expect(screen).toMatch(/<Glyph name="up" color=\{canSend \? ink\(K\.primary\) : K\.text4\} size=\{20\} \/>/);
  });

  test("one capsule for both modes, so the field is always a field", () => {
    // `keys` mode used to be filled with no border to say "this is a button".
    // The keyboard glyph inside it says that instead.
    expect(screen).not.toMatch(/backgroundColor: raw \? K\.bg3 : K\.bg2,/);
    expect(screen).not.toMatch(/borderWidth: raw \? 0 : 1,/);
  });

  test("the capsule has air around its icons", () => {
    /*
     * A target at the floor inside a field that is the target plus the gutter,
     * as the drawing has it: the icons used to fill the capsule edge to edge,
     * so the capsule WAS the picture button rather than a field it sits in.
     * `borderRadius: RADIUS.pill, paddingLeft…` is the capsule's own style.
     */
    const capsule = between("borderRadius: RADIUS.pill, paddingLeft: SPACE.md, paddingRight: SPACE.xs,", "{raw ? (");
    expect(capsule).toMatch(/paddingVertical: SPACE\.xs,/);
  });

  test("the placeholder is the drawing's sentence", () => {
    // "Write a line" named the act; "Tap to show keyboard" says what the field
    // does, which on a phone is the question somebody has with a thumb.
    expect(screen).toMatch(/: "Tap to show keyboard"/);
    expect(screen).not.toMatch(/mirror \? "The pane's line"/);
  });
});

describe("the strip above", () => {
  test("a tab is a pill with the accent on it, not an underline", () => {
    expect(screen).toMatch(/borderColor: on \? K\.primary : K\.border,/);
    expect(screen).toMatch(/backgroundColor: pressed \? K\.bg4 : on \? tint\(K\.primary, 0\.14\) : K\.bg2,/);
    expect(screen).not.toMatch(/borderBottomWidth: 2,/);
  });

  test("every tab name carries the same weight, as the drawing sets them", () => {
    // Unselected names at 400 beside a 600 one read as disabled tabs; the mock
    // sets the whole strip at 600 and lets the accent say which is on.
    expect(screen).not.toMatch(/fontWeight: on \? "600" : "400",/);
  });

  test("the state is the dot, and the word stays in the label", () => {
    // The word under the name was a second line on every tab. It is still what
    // a screen reader hears, and still what the switcher's row says.
    expect(screen).not.toMatch(/\{word\}<\/Text>/);
    expect(screen).toMatch(/accessibilityLabel=\{`\$\{tab\.name\}, \$\{word\}/);
  });

  test("a finished window is a card, not a bar across the screen", () => {
    expect(screen).toMatch(/borderRadius: RADIUS\.lg,\s*\n\s*backgroundColor: tint\(K\.success, 0\.14\),/);
  });
});
