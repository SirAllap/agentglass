/*
 * The one property the prompt preview must not quietly cost us.
 *
 * `src/model/reviewMenu.ts` states it as a rule: the socket carries an ID and
 * never a prompt, so a socket reachable from the UI cannot become a way to
 * choose what an agent is told. Until the preview existed, that rule was easy
 * to keep by accident — the phone never held the words, so there was nothing
 * to send even if somebody wanted to.
 *
 * Now it does hold them. `/prs/review-prompt` reads the built text back so it
 * can be shown, and the words sit in state one line away from the call that
 * opens the window. Turning that preview into what gets SENT is a two-word
 * edit that would typecheck, pass every other test, and look like a feature.
 *
 * So it is checked here, by reading the screen rather than by running it: a
 * behavioural test would have to reach into the socket, and the failure being
 * guarded against is not a wrong value at runtime but a wrong SHAPE in the
 * source. This is the same instrument web/test/pending-in-files.test.ts uses,
 * for the same kind of claim.
 */
import { describe, expect, test } from "bun:test";

const pr = await Bun.file(new URL("../app/pr/[number].tsx", import.meta.url)).text();
const card = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();

/** The argument object of every `requestHandoff({...})` in a file. Matched on
 *  the braces rather than parsed, which is enough: the call is written literally
 *  at both sites and a version that was not would fail this loudly. */
function frames(src: string): string[] {
  return [...src.matchAll(/requestHandoff\(\{([\s\S]*?)\}\);/g)].map((m) => m[1] ?? "");
}

describe("what the review hand-off puts on the socket", () => {
  const sent = frames(pr);

  test("there is exactly one of them", () => {
    // Two call sites is how the second one quietly grows a field the first
    // does not have.
    expect(sent.length).toBe(1);
  });

  test("it carries the recipe id", () => {
    expect(sent[0]).toContain("cmd: \"review\"");
    expect(sent[0]).toMatch(/\brecipe\b/);
  });

  test("it does NOT carry a prompt", () => {
    /* The whole point. `prepareReviewPrompt` builds the text on the computer
       and builds it again when the window opens; what this screen read back is
       for a person to look at, and nothing else. A `prompt:` here would mean
       the phone had started choosing the words. */
    expect(sent[0]).not.toMatch(/\bprompt\s*:/);
  });

  test("the preview is read-only — nothing types into it", () => {
    /* An editable preview is the same breach by another route, and it would
       arrive as a TextInput bound to the prompt. Whether the phone should be
       allowed to send words of its own is a decision about what this app is;
       it is not something that should be able to appear in a diff about
       layout. */
    const preview = pr.slice(pr.indexOf("preview?.state === \"read\""));
    expect(preview.slice(0, preview.indexOf("</Sheet>"))).not.toContain("TextInput");
  });
});

describe("what the card hand-off puts on the socket", () => {
  const sent = frames(card);

  test("there is exactly one of them", () => {
    expect(sent.length).toBe(1);
  });

  test("its prompt is built by the shared helper, not spelled here", () => {
    /* A card hand-off DOES carry a prompt — it always has, and `cmd: "issue"`
       is defined that way. What must not drift is the shape of the line: the
       desk and the phone both invoke a skill as `/name ID`, from
       shared/cardSkills.ts, because that is the string those skills were
       written against. A second spelling here would work on the day it was
       written and diverge from there. */
    expect(sent[0]).toMatch(/\bprompt\b/);
    expect(card).toContain("skillCommand(");
    expect(card).toContain("shared/cardSkills.ts");
  });

  test("it does not ask the server to skip permission prompts", () => {
    /* `yolo` buys exactly one flag — `--dangerously-skip-permissions` — and no
       screen on this phone asks for it. A skill's own `[autonomous | yolo]`
       modes are WORDS IN A PROMPT that the skill itself reads; they must never
       be mistaken for the frame's boolean, which is a different thing with a
       much longer reach. */
    expect(sent[0]).not.toMatch(/\byolo\s*:/);
  });
});
