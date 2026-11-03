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
 * These read `PrPanel.tsx` and `PrAskPicker.tsx` as text, which is a weak kind of test and the honest
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

/* The card half of the review picker lives in PrAskPicker.tsx: a hook that reads the card and the component that applies. */
const ask = await Bun.file(new URL("../src/components/PrAskPicker.tsx", import.meta.url)).text();
const upto = (from: string, to: string) => { const i = ask.indexOf(from); expect(i, `no ${from}`).toBeGreaterThan(-1); const j = ask.indexOf(to, i + 1); return ask.slice(i, j === -1 ? undefined : j); };
const CLICKUP = upto("export function usePrCardSide(", "\n/** Jira finds people");
const FLOW = ask.slice(ask.indexOf("export function PrAskPicker("));
const PICKER = bodyOf("FieldPicker");
const FACTS = bodyOf("CardFacts");

describe("the window that went black", () => {
  it("runs every hook before the render that may not happen", () => {
    /*
     * `mergeCardRef` is null until `useClickupSetup` answers — a read cached for
     * a minute, so a menu opened later has one render with no card and the next
     * with one. The plan and the write once lived BELOW `if (!ref) return null`,
     * so those two renders ran a different number of hooks and React threw the
     * whole tree away. The hook now decides a STATE, never an early return, and
     * the component has a single return at its end.
     */
    expect(CLICKUP).not.toMatch(/return null;/);
    expect(CLICKUP.match(/\n  return \{/g)?.length).toBe(1);
    expect(FLOW).not.toMatch(/\n  if \(.*\) return/);
    expect(FLOW.match(/\n  return \(/g)?.length).toBe(1);
    const tail = FLOW.slice(FLOW.indexOf("\n  return ("));
    expect(/\buse[A-Z]\w*\(/.exec(tail)?.[0] ?? "none", "a hook below the return").toBe("none");
  });

  it("draws a state for a pull request with no card instead of an empty half", () => {
    expect(CLICKUP).toContain('else if (!ref || !kind) state = "unlinked";');
    expect(CLICKUP).toContain('if (!setup.connected && !setup.jira) state = "none";');
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
    // lands, so the write's own answer replaces it — the board reads the same.
    expect(pick).toContain("putCard(query, r.task)");
  });

  it("shows who is on it, as faces", () => {
    // In the Assigned control itself, as in the card view, not a list above it.
    const control = bodyOf("CardPeoplePick");
    expect(control).toContain("task.people ?? []");
    expect(control).toContain('"nobody"');
    expect(FACTS).toContain("<CardPeoplePick");
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

  it("is the second reader of a lookup the menu replaces when it writes", () => {
    expect(CLICKUP).toContain("putCard(query, t);");
  });
});

describe("the people who reset themselves", () => {
  it("looks the card up by its id, not by the object the id arrived in", () => {
    /* `d` is a new object on every poll of the pull request. Keyed on `d`, the
       lookup effect re-ran every few seconds and replaced what had just been
       ticked with whatever the card held. */
    expect(CLICKUP).toMatch(/const query = ref\?\.query \?\? ""/);
    expect(CLICKUP).toMatch(/const query = ref\?\.query \?\? ""/);
    /* The card is read through the shared store (a lookup the board and the sidebar already made), the list by the card's own list id. */
    expect(CLICKUP).not.toContain("api.clickupFind");
    expect(CLICKUP).toContain("}, [o.on, kind, listId]);");
    expect(CLICKUP).not.toMatch(/\n  \}, \[ref\]\);/);
  });

  it("memoizes the reference on the fields it reads, not on the pull request", () => {
    expect(CLICKUP).toContain("[d.headRefName, d.title, d.body, d.card, setup]");
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
    expect(FLOW.match(/api\.clickupCard\(/g)?.length).toBe(1);
    expect(ask).not.toContain("api.clickupAssign(");
    expect(ask).not.toContain("api.clickupStatus(");
  });

  it("checks the answer and says what it was", () => {
    // The old loop was inside a `try` that could not fail: the failure came
    // back as `{ ok: false }`, which is not thrown, so every outcome read as
    // success and nothing was reported either way. Each step now carries its own outcome.
    expect(FLOW).toContain('res[id] = r.ok ? { state: "ok" } : said(r.error);');
    expect(FLOW).toContain('res["card-extras"] = ex?.ok ? { state: "ok" } : said(ex?.error);');
  });

  it("moves the stamp after a write so the next one is not refused", () => {
    expect(FLOW).toContain("if (r.ok) sd.advance(r.task);");
    expect(CLICKUP).toContain("advance: (t) => { if (t) { taskRef.current = t; putCard(query, t); } },");
  });

  it("builds the summary and the write from the same plan", () => {
    expect(FLOW).toContain("const plan = useMemo(() => handOverPlan({");
    expect(FLOW).toContain("runSteps(plan.steps, ids,");
    expect(FLOW).toContain("{ add: add.map((p) => Number(p.key))");
  });

  it("does not hold the card for GitHub: each system answers for itself and only the failed one is retried", () => {
    /* "GitHub first, and the card only if it landed" left a card untouched
       whenever GitHub was slow. The result has one row per system and
       `Retry only X` sends just that system's steps again. */
    const card = FLOW.slice(FLOW.indexOf("const cardRunner: Runner"), FLOW.indexOf("const run = (ids"));
    expect(card.length).toBeGreaterThan(500);
    expect(card).not.toContain("sendGithub");
    expect(FLOW).toContain("{ github, ...(side.kind ? { [side.kind]: cardRunner } : null) }");
    expect(FLOW).toContain("run(r.retry)");
    expect(FLOW).toContain("dismissible={result.phase !== \"working\"}");
  });

  it("names who goes on and who comes off", () => {
    expect(FLOW).toContain("...(dropPeople.length ? { drop: dropPeople.map((p) => p.name) } : null)");
    expect(FLOW).toContain("rem: drop.map((p) => Number(p.key))");
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
