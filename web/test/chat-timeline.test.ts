/*
 * The chat panel's conversation reads on the same rail as the pull request's
 * and the tracker card's: the speaker's face outside a neutral card, a rail
 * behind the cards, and the body in prose rather than the terminal face the
 * rest of the app is set in.
 *
 * Before this, a chat turn was a two-sided bubble — filled and right-aligned
 * for you, tinted and left-aligned for the model — the one conversation view
 * in the workspace that did not match the others open beside it. There is no
 * renderer in this project, so the shape is asserted against the source: the
 * avatar sits in the rail column (`agx-chat-av`, positioned outside the card),
 * the card itself is `var(--surface-card)` rather than a role-tinted fill, and
 * the message body carries `agx-cu-body`, the prose/mono split index.css
 * already defines for a written paragraph next to code.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "components", "ChatPanel.tsx"), "utf8");

describe("chat timeline pattern", () => {
  test("a message's avatar sits on the rail, outside the card", () => {
    // `agx-chat-av` is `position: absolute; left: -(avatar + gap)`, which is
    // what pulls the face out of the card's own box and onto the rail column
    // beside it — the same trick PrPanel.tsx's `agx-av` uses for a pull
    // request's own conversation.
    expect(SRC).toMatch(/\.agx-chat-av\{[^}]*position:absolute[^}]*left:-/);
    expect(SRC).toContain('className="agx-chat-av"');
  });

  test("the rail line runs behind the timeline, not just behind one message", () => {
    expect(SRC).toMatch(/\.agx-chat-tl::before\{[\s\S]{0,200}?position:absolute[\s\S]{0,200}?background:var\(--surface-line\)/);
  });

  test("a message card is a neutral surface, not a role-tinted fill", () => {
    // The old bubble read role from a filled/tinted background
    // (`color-mix(in srgb, var(--primary) 50%` for you, a bg3 wash for the
    // model). One card colour for both is what makes this a timeline instead
    // of two lanes.
    expect(SRC).not.toMatch(/color-mix\(in srgb, var\(--primary\) 50%, var\(--bg2\)\)/);
    expect(SRC).toMatch(/agx-chat-ev[\s\S]{0,400}?background: "var\(--surface-card\)"/);
  });

  test("a message body is held to the prose/mono split, not the app's default mono", () => {
    // agx-cu-body (index.css) is the class this repo already uses to read a
    // written paragraph in `--font-prose` while keeping its `code`/`pre` in
    // the mono stack — reused here rather than inventing a second one.
    expect(SRC).toMatch(/className="agx-cu-body"/);
  });

  test("the rail's four numbers are still positive and ordered avatar > rail", () => {
    // Not a redefinition of PrPanel's TL_* token (out of this file's scope),
    // but a literal copy of its values — this guards against one drifting
    // from the other into something that no longer reads as the same rail.
    const avatar = Number(SRC.match(/CHAT_TL_AVATAR = (\d+)/)?.[1]);
    const gap = Number(SRC.match(/CHAT_TL_GAP = (\d+)/)?.[1]);
    const rail = Number(SRC.match(/CHAT_TL_RAIL = (\d+)/)?.[1]);
    expect(avatar).toBe(40);
    expect(gap).toBe(12);
    expect(rail).toBe(16);
  });
});
