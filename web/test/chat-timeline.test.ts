/*
 * The chat panel's conversation reads on the same rail as the pull request's
 * and the tracker card's: the speaker's face outside a neutral card, a rail
 * behind the cards, and the body in prose rather than the terminal face the
 * rest of the app is set in.
 *
 * Before this, a chat turn was a two-sided bubble — filled and right-aligned
 * for you, tinted and left-aligned for the model — the one conversation view
 * in the workspace that did not match the others open beside it. Later, a
 * second batch built the same rail again independently, under a
 * `CHAT_TL_*`/`agx-chat-*` prefix, before the two were merged onto the one
 * copy — `TL_*`/`TL_CSS` and the `.agx-tl`/`.agx-ev`/`.agx-av` classes in
 * workspace/Chrome.tsx — that PrPanel.tsx and TasksPanel.tsx already used.
 * There is no renderer in this project, so the shape is asserted against the
 * source: the avatar sits in the rail column (`agx-av`, positioned outside
 * the card), the card itself is `var(--surface-card)` rather than a
 * role-tinted fill, and the message body carries `agx-cu-body`, the
 * prose/mono split index.css already defines for a written paragraph next to
 * code.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "components", "ChatPanel.tsx"), "utf8");
const CHROME_SRC = readFileSync(join(import.meta.dir, "..", "src", "components", "workspace", "Chrome.tsx"), "utf8");

describe("chat timeline pattern", () => {
  test("ChatPanel imports the shared rail tokens and CSS from Chrome.tsx", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bTL_AVATAR\b[^}]*\}\s*from\s*"\.\/workspace\/Chrome\.tsx"/);
    expect(SRC).toMatch(/import\s*\{[^}]*\bTL_CSS\b[^}]*\}\s*from\s*"\.\/workspace\/Chrome\.tsx"/);
  });

  test("ChatPanel no longer defines its own copy of the timeline tokens or CSS", () => {
    // The full identifiers, with word-boundary delimiters, not a substring —
    // `CHAT_TL_AVATAR` used to be `const CHAT_TL_AVATAR = 40;` and similar for
    // the other three numbers and the CSS string; none of those local
    // definitions should exist any more.
    expect(SRC).not.toMatch(/\bconst CHAT_TL_AVATAR\b/);
    expect(SRC).not.toMatch(/\bconst CHAT_TL_GAP\b/);
    expect(SRC).not.toMatch(/\bconst CHAT_TL_RAIL\b/);
    expect(SRC).not.toMatch(/\bconst CHAT_TL_SPACE\b/);
    expect(SRC).not.toMatch(/\bconst CHAT_TL_CSS\b/);
    // And the file no longer renders the old `agx-chat-*` class family.
    expect(SRC).not.toMatch(/\bagx-chat-tl\b/);
    expect(SRC).not.toMatch(/\bagx-chat-ev\b/);
    expect(SRC).not.toMatch(/\bagx-chat-av\b/);
  });

  test("a message's avatar sits on the rail, outside the card", () => {
    // `.agx-av` is `position: absolute; left: -(avatar + gap)`, which is what
    // pulls the face out of the card's own box and onto the rail column
    // beside it — the same shared rule PrPanel.tsx's conversation uses.
    expect(CHROME_SRC).toMatch(/\.agx-av\{[^}]*position:absolute[^}]*left:-/);
    expect(SRC).toContain('className="agx-av"');
  });

  test("the rail line runs behind the timeline, not just behind one message", () => {
    expect(CHROME_SRC).toMatch(/\.agx-tl::before\{[\s\S]{0,200}?position:absolute[\s\S]{0,200}?background:var\(--surface-line\)/);
    expect(SRC).toContain('className="agx-tl"');
  });

  test("a message card is a neutral surface, not a role-tinted fill", () => {
    // The old bubble read role from a filled/tinted background
    // (`color-mix(in srgb, var(--primary) 50%` for you, a bg3 wash for the
    // model). One card colour for both is what makes this a timeline instead
    // of two lanes.
    expect(SRC).not.toMatch(/color-mix\(in srgb, var\(--primary\) 50%, var\(--bg2\)\)/);
    expect(SRC).toMatch(/agx-ev[\s\S]{0,400}?background: "var\(--surface-card\)"/);
  });

  test("a message body is held to the prose/mono split, not the app's default mono", () => {
    // agx-cu-body (index.css) is the class this repo already uses to read a
    // written paragraph in `--font-prose` while keeping its `code`/`pre` in
    // the mono stack — reused here rather than inventing a second one.
    expect(SRC).toMatch(/className="agx-cu-body"/);
  });

  test("the rail's numbers, shared with the rest of the workspace, are still positive and ordered avatar > rail", () => {
    // Not redefined here — this guards Chrome.tsx's own values, which
    // PrPanel.tsx, TasksPanel.tsx and ChatPanel.tsx now all read from one
    // place, against one of them drifting into something that no longer
    // reads as the same rail.
    const avatar = Number(CHROME_SRC.match(/TL_AVATAR = (\d+)/)?.[1]);
    const gap = Number(CHROME_SRC.match(/TL_GAP = (\d+)/)?.[1]);
    const rail = Number(CHROME_SRC.match(/TL_RAIL = (\d+)/)?.[1]);
    expect(avatar).toBe(40);
    expect(gap).toBe(12);
    expect(rail).toBe(16);
  });
});
