/*
 * The reviewer menu and the card it also moves — four faults from one sitting,
 * each pinned here.
 *
 * Reported together, with screenshots: ticking a reviewer assigned them without
 * Done ever being pressed; the ClickUp people went back to how they were a few
 * seconds later; the confirmation promised a move and two assignments and only
 * one of them happened; and opening the menu again a while later left the whole
 * window black.
 *
 * These read `PrPanel.tsx` as text, which is a weak kind of test and the honest
 * one available here: three of the four are invariants about WHERE code sits —
 * hooks above a conditional return, a dependency that is a string rather than
 * an object — and there is no DOM under `bun test` to re-render a component in.
 * The behaviour they protect is measured in card-plan.test.ts and, on the
 * server, in clickup.test.ts.
 *
 * Worth saying plainly: this repository has no eslint, so
 * `react-hooks/rules-of-hooks` — which is exactly the rule the black window
 * broke — has never run over it. The `eslint-disable` comments in the source
 * are addressed to a linter that is not installed.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** One top-level function's body. Nested functions are indented, so a `function`
 *  at column zero is the next one along. */
const bodyOf = (name: string) => {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `no function ${name}`).toBeGreaterThan(-1);
  const j = src.indexOf("\nfunction ", i + 1);
  return src.slice(i, j === -1 ? undefined : j);
};

const CLICKUP = bodyOf("ClickUpSide");
const PICKER = bodyOf("FieldPicker");
const FACTS = bodyOf("CardFacts");

describe("the window that went black", () => {
  it("runs every hook before the render that may not happen", () => {
    /*
     * `mergeCardRef` is null until `useClickupSetup` answers — a read cached for
     * a minute, so a menu opened later has one render with no card and the next
     * with one. The plan and the write lived BELOW `if (!ref) return null`, so
     * those two renders ran a different number of hooks and React threw the
     * whole tree away.
     */
    const tail = CLICKUP.slice(CLICKUP.indexOf("if (!ref) return null;"));
    expect(tail.length).toBeGreaterThan(200);
    const hook = /\buse[A-Z]\w*\(/.exec(tail);
    expect(hook?.[0] ?? "none", "a hook below the early return").toBe("none");
  });

  it("keeps the early return, rather than drawing an empty half", () => {
    // The fix is not "always render": a pull request with no card must draw
    // nothing here at all.
    expect(CLICKUP).toContain("if (!ref) return null;");
  });

  it("holds the same line in the sidebar, which has the same shape", () => {
    // `CardFacts` reads the same setup and returns null the same way. It is one
    // `useMemo` away from the same black window.
    const tail = FACTS.slice(FACTS.indexOf("if (!ref) return null;"));
    expect(tail.length).toBeGreaterThan(200);
    expect(/\buse[A-Z]\w*\(/.exec(tail)?.[0] ?? "none").toBe("none");
  });
});

describe("where the card stands, beside the pull request", () => {
  it("shows the status in the colour its own board gave it, and it is a control", () => {
    /* A board is read by colour before it is read by word; a status torn out of
       its colour is one somebody has to stop and parse. The pill is the
       Select's own trigger now (`pill: true` draws a StatusPill), because the
       sidebar stopped being read-only: "if I only want to change the card
       status and the assignee… I don't want to go to the card, I want to do it
       from the PR". */
    expect(FACTS).toContain("<CardStatusPick task={task} query={query}");
    const pick = bodyOf("CardStatusPick");
    expect(pick).toContain("pill: true");
    expect(pick).toContain("tint: x.color");
    // The colour the board gave it survives even before the list has answered.
    expect(pick).toContain("color: task.statusColor ?? \"\"");
  });

  it("and one press is one write, with the card's own stamp", () => {
    /* No Done button and nothing to forget. `updated` rides along because
       ClickUp refuses a write made against a stamp older than the card's —
       the guard that once let a batch of three apply only its first. */
    const pick = bodyOf("CardStatusPick");
    expect(pick).toContain("api.clickupCard(task.id, { status }, task.updated)");
    const people = bodyOf("CardPeoplePick");
    expect(people).toContain("off ? { rem: [m.id] } : { add: [m.id] }, task.updated");
    /* And it is the app's ONE people picker, not a dropdown of names of its
       own: "that selection modal opens outside the window, and it doesn't follow
       the standard, which should be this one". See components/PeoplePick. */
    expect(people).toContain("<PeoplePick");
    // And what we are holding about the card stops being true the moment it
    // lands, so it is thrown away rather than left to go stale on screen.
    expect(pick).toContain("forgetCard(query)");
  });

  it("shows who is on it, as faces", () => {
    expect(FACTS).toContain("task.people?.length");
    expect(FACTS).toContain("No one assigned");
  });

  it("fills the hole while it is asking rather than appearing late", () => {
    // His words about the board, and it applies here: a section that pops in a
    // second after the rest of the sidebar reads as a glitch.
    expect(FACTS).toContain("Reading the card…");
  });

  it("reads through the shared store, not its own request", () => {
    expect(FACTS).toContain("const hit = cardOf(query);");
    expect(FACTS).not.toContain("api.clickupFind");
  });

  it("is the second reader of a lookup the menu invalidates when it writes", () => {
    expect(CLICKUP).toContain("forgetCard(query);");
  });
});

describe("the people who reset themselves", () => {
  it("looks the card up by its id, not by the object the id arrived in", () => {
    /* `d` is a new object on every poll of the pull request. Keyed on `d`, the
       lookup effect re-ran every few seconds and replaced what had just been
       ticked with whatever the card held. */
    expect(CLICKUP).toMatch(/const query = ref\?\.query \?\? ""/);
    expect(CLICKUP).toMatch(/await api\.clickupFind\(query\)/);
    // The effect's dependency is that string and nothing else.
    expect(CLICKUP).toMatch(/\n  \}, \[query\]\);/);
    expect(CLICKUP).not.toMatch(/\n  \}, \[ref\]\);/);
  });

  it("memoizes the reference on the fields it reads, not on the pull request", () => {
    expect(CLICKUP).toContain("[d.headRefName, d.title, d.body, setup]");
  });
});

describe("the confirmation that came half true", () => {
  it("sends one write for the whole card", () => {
    /*
     * Three writes each carried `card.updated`, the stamp read when the menu
     * opened; the first moves that stamp, so ClickUp refused the other two as
     * "somebody changed this card while you had it open". Ana went on, Rob
     * never came off, the status never moved.
     */
    expect(CLICKUP).toContain("api.clickupCard(");
    expect(CLICKUP).not.toContain("api.clickupAssign(");
    expect(CLICKUP).not.toContain("api.clickupStatus(");
  });

  it("checks the answer and says what it was", () => {
    // The old loop was inside a `try` that could not fail: the failure came
    // back as `{ ok: false }`, which is not thrown, so every outcome read as
    // success and nothing was reported either way.
    expect(CLICKUP).toContain("note(r.ok,");
    expect(CLICKUP).toContain("return r.ok;");
  });

  it("builds the summary and the write from the same plan", () => {
    expect(CLICKUP).toContain("cardPlan({");
    expect(CLICKUP).toContain("{ add: plan.add, rem: plan.drop, status: plan.status || undefined }");
    expect(CLICKUP).toContain("lines: folded ? [] : plan.lines");
  });

  it("waits for GitHub before it touches the card", () => {
    // "GitHub first, and ClickUp only if it landed" was a comment over a call
    // nobody awaited.
    expect(PICKER).toContain("const wrote = await onCommit(selRef.current);");
    expect(PICKER).toContain("if (wrote === false)");
  });

  it("claims a GitHub write only when there is one", () => {
    expect(PICKER).toContain("{ghChanged > 0 && (() => {");
    expect(PICKER).toContain("<div>· {title} on GitHub</div>");
  });

  it("names who goes on and who comes off, with their face", () => {
    /* The line was the picker's own title — "Request reviewers on GitHub" —
       printed for a step that was taking a reviewer OFF. The ClickUp lines
       under it named the person in both directions, so the one row that could
       not be checked was the row about the write that is hardest to undo.
       Reported as: it should say remove that user, with the avatar adding one
       already has. */
    expect(PICKER).toContain("const add = sel.filter((x) => !selected.includes(x));");
    expect(PICKER).toContain("const gone = selected.filter((x) => !sel.includes(x));");
    expect(PICKER).toContain("<Avatar login={o.avatar} size={14} />");
    expect(PICKER).toContain('{on ? "+" : "−"}');
  });
});

describe("the reviewer nobody pressed Done for", () => {
  it("does not write on the way out", () => {
    /* An outside click used to commit, the way GitHub's own label menu does.
       With a Done button on the menu that is a second, invisible writer — and
       it is the one that fired. */
    expect(PICKER).not.toContain("commitClose");
    const away = /const away = \(e: MouseEvent\) => \{[^}]*\}/.exec(PICKER)?.[0] ?? "";
    expect(away).toContain("onClose()");
    expect(away).not.toContain("onCommit");
  });

  it("closes on a resize without writing either", () => {
    expect(PICKER).toContain('window.addEventListener("resize", onClose);');
  });
});

/*
 * And the menu that closed the menu.
 *
 * "If I click the status, this modal/selector just closes on me." The card's
 * status is chosen with the app's own Select, which portals its list to the
 * body so it can escape the picker's clipping — so the press landed outside the
 * picker's box and the dismiss-on-outside-click closed the whole thing before
 * the choice could be made.
 */
describe("a menu opened from a menu", () => {
  it("does not count as clicking away", () => {
    const select = readFileSync(new URL("../src/components/Select.tsx", import.meta.url), "utf8");
    // The list and its scrim are both marked, because the press lands on the
    // scrim as often as on an option.
    expect((select.match(/data-menu-layer/g) ?? []).length).toBe(2);
    expect(src).toContain('if (t?.closest?.("[data-menu-layer]")) return;');
  });
});

/*
 * THE FILTER TAKES ITS OWN FOCUS, WITHOUT A CLICK.
 *
 * `autoFocus` does not take here: React applies it at commit time, in the
 * same pass that first renders the input, and this menu renders through
 * `<Portal>` — which only appends its container to `document.body` in ITS
 * OWN effect, and child effects fire before parent effects. So the input got
 * focused while its container was still a detached node, `.focus()` on that
 * is a silent no-op, and both "Apply labels" and "Request reviewers" opened
 * with the mouse as the only way in: "without having to move the mouse around
 * to click on the input". Same root cause `palette-menu-keys.test.ts`
 * already found and fixed for a different menu, and the same shape of fix:
 * a ref, focused from an effect deferred past the current commit rather than
 * the `autoFocus` attribute.
 */
describe("the filter takes its own focus", () => {
  it("does not rely on autoFocus, which the Portal race defeats", () => {
    expect(PICKER.match(/autoFocus(?=[\s>/])/g)).toBe(null);
  });

  it("focuses the filter input from an effect deferred to the next frame", () => {
    expect(PICKER).toContain("const filterInput = useRef<HTMLInputElement>(null);");
    expect(PICKER).toMatch(/requestAnimationFrame\(\(\) => filterInput\.current\?\.focus\(\)\)/);
    expect(PICKER).toContain('<input ref={filterInput}');
  });
});
