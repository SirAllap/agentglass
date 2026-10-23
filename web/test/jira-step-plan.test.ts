/*
 * What a Jira step will do, as the rows the confirmation draws: one per block in
 * the order the server runs them, a plain sentence each, and a row that would
 * change nothing says so. The same table runs over Cloud's step shape (account
 * ids) and Data Center's (logins), because a person's id is the only thing that
 * differs between them and a row compares it with who is on the card.
 */
import { describe, expect, test } from "bun:test";
import { actionLabel, alreadyLinked, assignable, onCard, planRows, tintOf, plainFailure, ruleBlocks, settleRows, type PlanInput, type PlanPerson } from "../src/lib/jiraStepPlan.ts";
import type { StepBlock } from "../../shared/providers.ts";

const who = (key: string, name: string, me = false): PlanPerson => ({ key, name, initials: name.split(" ").map((w) => w[0]).join(""), ...(me ? { me: true } : null) });

const FLAVORS = [
  { flavor: "Cloud", ada: who("acc-0001", "Ada Tester", true), lin: who("acc-0003", "Lin Tester") },
  { flavor: "Data Center", ada: who("ada", "Ada Tester", true), lin: who("lin", "Lin Tester") },
];

const PR = { url: "https://github.com/acme/orbit/pull/2198", title: "Retry the export", number: 2198, author: "octo-ada" };

for (const { flavor, ada, lin } of FLAVORS) {
  const card = (over: Partial<PlanInput["card"]> = {}): PlanInput["card"] => ({ key: "ORBIT-1042", title: "Export fails on retry", status: "In Progress", assignee: lin, ...over });
  const input = (blocks: StepBlock[], over: Partial<PlanInput> = {}): PlanInput => ({ blocks, card: card(), target: null, choice: {}, pr: PR, linked: false, people: [ada, lin], ...over });

  describe(`rows, ${flavor}`, () => {
    test("rows come in run order whatever order the blocks were saved in", () => {
      const rows = planRows(input([
        { type: "link" }, { type: "comment", text: "Opened {pr}" }, { type: "assign", who: "me" },
        { type: "unassign", who: "all" }, { type: "move", statusNames: ["In Review"] },
      ], { target: "In Review" }));
      expect(rows.map((r) => r.kind)).toEqual(["move", "unassign", "assign", "comment", "link"]);
    });

    test("move: from the card's status to the target, in words", () => {
      const [r] = planRows(input([{ type: "move", statusNames: ["In Review"] }], { target: "In Review" }));
      expect(r!.sentence).toBe("Move ORBIT-1042 from In Progress to In Review");
      expect(r!.noop).toBeNull();
      expect(r!.outcome).toBe("move");
    });

    test("move: a card already there says it does nothing, whatever the case", () => {
      const [r] = planRows(input([{ type: "move", statusNames: ["in review"] }], { target: "in review", card: card({ status: "In Review" }) }));
      expect(r!.noop).toBe("Already in In Review, so this does nothing");
    });

    test("move that still has to be picked says where the pick is", () => {
      const [r] = planRows(input([{ type: "move", statusNames: [], ask: true }]));
      expect(r!.sentence).toBe("Move ORBIT-1042 to the status you pick");
      expect(r!.noop).toBeNull();
    });

    test("unassign everyone names the person and shows them struck", () => {
      const [r] = planRows(input([{ type: "unassign", who: "all" }]));
      expect(r!.sentence).toBe("Take Lin Tester off the card");
      expect(r!.people).toEqual([lin]);
      expect(r!.noop).toBeNull();
    });

    test("unassign with nobody on the card does nothing", () => {
      const [r] = planRows(input([{ type: "unassign", who: "all" }], { card: card({ assignee: null }) }));
      expect(r!.noop).toBe("Nobody is on the card, so there is nothing to take off");
    });

    test("unassign me: nothing when somebody else is on it, a take-off when it is me", () => {
      const other = planRows(input([{ type: "unassign", who: "me" }]))[0]!;
      expect(other.noop).toBe("You are not on the card, so there is nothing to take off");
      const mine = planRows(input([{ type: "unassign", who: "me" }], { card: card({ assignee: ada }) }))[0]!;
      expect(mine.noop).toBeNull();
      expect(mine.sentence).toBe("Take Ada Tester off the card");
    });

    test("unassign named people compares the id the flavor keeps", () => {
      const named = [{ id: lin.key, name: "Lin Tester" }];
      expect(planRows(input([{ type: "unassign", who: "people", people: named }]))[0]!.noop).toBeNull();
      expect(planRows(input([{ type: "unassign", who: "people", people: named }], { card: card({ assignee: ada }) }))[0]!.noop)
        .toBe("Lin Tester is not on the card, so there is nothing to take off");
    });

    test("unassign that asks follows the tick the person made", () => {
      const b: StepBlock[] = [{ type: "unassign", who: "all", ask: true }];
      expect(planRows(input(b, { choice: { clear: true } }))[0]!.noop).toBeNull();
      expect(planRows(input(b, { choice: { clear: false } }))[0]!.noop).toBe("You chose to leave Lin Tester on the card");
    });

    test("assign me, a named person, nobody on it already", () => {
      const me = planRows(input([{ type: "assign", who: "me" }]))[0]!;
      expect(me.sentence).toBe("Assign the card to Ada Tester");
      expect(me.people).toEqual([ada]);
      const named = planRows(input([{ type: "assign", who: "person", person: { id: lin.key, name: "Lin Tester" } }]))[0]!;
      expect(named.noop).toBe("Lin Tester is already on the card");
      const mine = planRows(input([{ type: "assign", who: "me" }], { card: card({ assignee: ada }) }))[0]!;
      expect(mine.noop).toBe("Ada Tester is already on the card");
    });

    test("assign that asks: left as is, nobody, or the person picked", () => {
      const b: StepBlock[] = [{ type: "assign", who: "none", ask: true }];
      expect(planRows(input(b))[0]!.noop).toBe("Left as it is: nobody is picked");
      expect(planRows(input(b, { choice: { assign: null } }))[0]!.sentence).toBe("Take the assignee off the card");
      const to = planRows(input(b, { choice: { assign: ada.key }, card: card({ assignee: null }) }))[0]!;
      expect(to.sentence).toBe("Assign the card to Ada Tester");
      expect(to.people).toEqual([ada]);
    });

    test("an assign that writes a person makes a take-off in the same step redundant, and says so", () => {
      const rows = planRows(input([{ type: "unassign", who: "all" }, { type: "assign", who: "me" }]));
      expect(rows[0]!.noop).toBe("Replaced by giving the card to Ada Tester");
      expect(rows[1]!.noop).toBeNull();
    });

    test("comment shows the text with the placeholders filled in", () => {
      const [r] = planRows(input([{ type: "comment", text: "{author} opened {pr} ({pr_url}), now {status}. cc {me}" }], { target: "In Review", me: "Ada Tester" }));
      expect(r!.detail).toBe("octo-ada opened #2198 Retry the export (https://github.com/acme/orbit/pull/2198), now In Review. cc Ada Tester");
      expect(r!.sentence).toBe("Comment on ORBIT-1042");
    });

    test("a placeholder this place cannot fill is kept visible and named", () => {
      const [r] = planRows(input([{ type: "comment", text: "cc {me}" }], { people: [lin] }));
      expect(r!.detail).toBe("cc {me}");
      expect(r!.note).toBe("{me} is filled in with your Jira name when it runs");
    });

    test("a comment the person edited is the text shown", () => {
      const [r] = planRows(input([{ type: "comment", text: "Opened {pr}", ask: true }], { choice: { comment: "By hand" } }));
      expect(r!.detail).toBe("By hand");
    });

    test("link: once, and a card that has it already says so", () => {
      const fresh = planRows(input([{ type: "link" }]))[0]!;
      expect(fresh.sentence).toBe("Link pull request #2198 on the card");
      expect(fresh.detail).toBe("Once: nothing happens if it is already there");
      expect(fresh.noop).toBeNull();
      const there = planRows(input([{ type: "link" }], { linked: true }))[0]!;
      expect(there.noop).toBe("Pull request #2198 is already on the card");
      const unknown = planRows(input([{ type: "link" }], { linked: null }))[0]!;
      expect(unknown.noop).toBeNull();
    });

    test("every block type that Jira holds has a row", () => {
      const all: StepBlock[] = [
        { type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }, { type: "assign", who: "me" },
        { type: "comment", text: "x" }, { type: "link" },
      ];
      expect(planRows(input(all)).map((r) => r.kind).sort()).toEqual(["assign", "comment", "link", "move", "unassign"]);
    });
  });
}

describe("settling rows from what the server answered", () => {
  const rows = planRows({
    blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "assign", who: "me" }, { type: "comment", text: "Opened {pr}" }, { type: "link" }],
    card: { key: "ORBIT-1042", title: "t", status: "In Progress", assignee: null }, target: "In Review", choice: {}, pr: PR, linked: false, people: [who("acc-0001", "Ada Tester", true)],
  });

  test("before it is pressed every row waits; while it runs they all run; nothing is invented", () => {
    expect(settleRows(rows, "idle", null).map((s) => s.state)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    expect(settleRows(rows, "running", null).map((s) => s.state)).toEqual(["running", "running", "running", "running"]);
  });

  test("a partial answer: the moved row done, the failed one says why in the server's own plain sentence", () => {
    const s = settleRows(rows, "finished", { ok: true, blocks: [
      { block: "move", state: "done" }, { block: "assignee", state: "done" },
      { block: "comment", state: "failed", why: "Jira did not accept the comment" }, { block: "link", state: "done" },
    ] });
    expect(s.map((x) => x.state)).toEqual(["done", "done", "failed", "done"]);
    expect(s[2]!.why).toBe("Jira did not accept the comment");
  });

  test("a block the server skipped is skipped, with its reason", () => {
    const s = settleRows(rows, "finished", { ok: true, blocks: [
      { block: "move", state: "skipped", why: "already in In Review" }, { block: "assignee", state: "done" },
      { block: "comment", state: "done" }, { block: "link", state: "skipped", why: "already on the card" },
    ] });
    expect(s.map((x) => x.state)).toEqual(["skipped", "done", "done", "skipped"]);
    expect(s[3]!.why).toBe("already on the card");
  });

  test("a row the server did not mention is not run; it is never shown done", () => {
    const s = settleRows(rows, "finished", { ok: true, blocks: [{ block: "move", state: "done" }] });
    expect(s.map((x) => x.state)).toEqual(["done", "skipped", "skipped", "skipped"]);
    expect(s[1]!.why).toBe("not run");
  });

  test("a refused run changes nothing: every row is not run and the reason is a sentence of ours", () => {
    const s = settleRows(rows, "finished", { ok: false, error: "Nothing was changed: could not read the card's moves. HTTP 500 <html>boom</html>" });
    expect(s.every((x) => x.state === "skipped" && x.why === "not run")).toBe(true);
  });

  test("plainFailure never carries what the site said", () => {
    expect(plainFailure({ ok: false, conflict: true, error: "Somebody changed this card while you were moving it, reloaded" })).toBe("Somebody changed the card while this was open. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, unauthorised: true, error: "401 token abc" })).toBe("Jira did not accept the saved sign-in. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "Nothing was changed: could not read the card's moves. HTTP 500 <html>boom</html>" })).toBe("Jira would not answer. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "Writing to Jira is switched off" })).toBe("Writing to Jira is switched off. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "Jira did not accept that move. The card may have moved on, or you cannot move it" })).toBe("Jira did not accept that move. The card may have moved on, or you cannot move it. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "ORBIT-1042 is already in In Review" })).toBe("The card is already in In Review. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "Nothing to do for ORBIT-1042" })).toBe("There was nothing to do for ORBIT-1042. Nothing in Jira was changed.");
    expect(plainFailure({ ok: false, error: "weird <b>text</b> from somewhere" })).toBe("Jira refused it. Nothing in Jira was changed.");
  });
});

describe("the button that confirms names what it will do", () => {
  const ada = who("acc-0001", "Ada Tester", true);
  const base = (blocks: StepBlock[], over: Partial<PlanInput> = {}): PlanInput => ({
    blocks, card: { key: "ORBIT-1042", title: "t", status: "In Progress", assignee: null }, target: "In Review", choice: {}, pr: PR, linked: false, people: [ada], ...over,
  });

  test("a move and a link", () => {
    expect(actionLabel(planRows(base([{ type: "move", statusNames: ["In Review"] }, { type: "link" }])))).toBe("Move to In Review and link the pull request");
  });
  test("three things read as a list", () => {
    expect(actionLabel(planRows(base([{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "x" }, { type: "link" }])))).toBe("Move to In Review, comment and link the pull request");
  });
  test("rows that change nothing are left out of the name", () => {
    expect(actionLabel(planRows(base([{ type: "move", statusNames: ["In Review"] }, { type: "link" }], { linked: true })))).toBe("Move to In Review");
  });
  test("a step that starts with something other than the move is capitalised", () => {
    expect(actionLabel(planRows(base([{ type: "assign", who: "me" }, { type: "comment", text: "x" }])))).toBe("Assign Ada Tester and comment");
  });
  test("nothing to change at all says so", () => {
    expect(actionLabel(planRows(base([{ type: "link" }], { linked: true })))).toBeNull();
  });
});

describe("the older per-project hand-off rule reads as blocks", () => {
  test("a fixed status and a take-off", () => {
    expect(ruleBlocks({ to: { id: "21", name: "In Review" }, askTo: false, clear: true, askClear: false })).toEqual([
      { type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" },
    ]);
  });
  test("asks keep asking, and no status is a pick", () => {
    expect(ruleBlocks({ to: null, askTo: true, clear: false, askClear: true })).toEqual([
      { type: "move", statusNames: [], ask: true }, { type: "unassign", who: "all", ask: true },
    ]);
  });
  test("a rule that does neither has no blocks", () => {
    expect(ruleBlocks({ to: null, askTo: false, clear: false, askClear: false })).toEqual([]);
  });
});

describe("people, as the rows draw them", () => {
  test("a person on the card keeps the picture and falls back to initials", () => {
    expect(onCard({ key: "acc-0001", name: "Ada Tester", initials: "AT", avatar: "https://avatar.example/ada.png", me: true })).toEqual({ key: "acc-0001", name: "Ada Tester", initials: "AT", avatar: "https://avatar.example/ada.png", color: tintOf("Ada Tester"), me: true });
    expect(onCard({ key: "acc-0003", name: "Lin Tester", initials: "" })?.initials).toBe("LT");
    expect(onCard({ name: "Nobody Keyed", initials: "NK" })).toBeNull();
    expect(onCard(undefined)).toBeNull();
  });
  test("a person to give the card to compares by the id a card carries and writes by the key", () => {
    expect(assignable({ key: "lin", id: "lin-id", name: "Lin Tester" })).toEqual({ key: "lin-id", writeKey: "lin", name: "Lin Tester", initials: "LT", color: tintOf("Lin Tester") });
  });
  test("a chosen person is found by the key a write sends", () => {
    const lin = assignable({ key: "lin", id: "lin-id", name: "Lin Tester" });
    const [r] = planRows({ blocks: [{ type: "assign", who: "none", ask: true }], card: { key: "ORBIT-1042", title: "t", status: "To Do", assignee: null }, target: null, choice: { assign: "lin" }, linked: null, people: [lin] });
    expect(r!.sentence).toBe("Assign the card to Lin Tester");
    expect(r!.people).toEqual([lin]);
  });
  test("a person already on the card is noticed whichever form the picker holds", () => {
    const lin = assignable({ key: "lin", id: "lin-id", name: "Lin Tester" });
    const [r] = planRows({ blocks: [{ type: "assign", who: "none", ask: true }], card: { key: "ORBIT-1042", title: "t", status: "To Do", assignee: onCard({ key: "lin-id", name: "Lin Tester", initials: "LT" }) }, target: null, choice: { assign: "lin" }, linked: null, people: [lin] });
    expect(r!.noop).toBe("Lin Tester is already on the card");
  });
});

describe("is the pull request already on the card", () => {
  const pr = "https://github.com/acme/orbit/pull/2198";
  test("the same address, however it is spelled", () => {
    expect(alreadyLinked({ links: [{ url: "https://GitHub.com/acme/orbit/pull/2198/" }], error: "" }, pr)).toBe(true);
    expect(alreadyLinked({ links: [{ url: `${pr}?diff=split` }], error: "" }, pr)).toBe(true);
  });
  test("another pull request, or none, is not", () => {
    expect(alreadyLinked({ links: [{ url: "https://github.com/acme/orbit/pull/2199" }], error: "" }, pr)).toBe(false);
    expect(alreadyLinked({ links: [], error: "" }, pr)).toBe(false);
  });
  test("links that could not be read claim nothing", () => {
    expect(alreadyLinked({ links: [], error: "Jira did not answer" }, pr)).toBeNull();
  });
});

describe("a colour for a person with no picture", () => {
  test("the same name is the same colour, and it is dark enough for white initials", () => {
    expect(tintOf("Rae Orbit")).toBe(tintOf("Rae Orbit"));
    expect(tintOf("Rae Orbit")).toMatch(/^hsl\(\d{1,3} 42% 38%\)$/);
    expect(onCard({ key: "k", name: "Rae Orbit", initials: "RO" })?.color).toBe(tintOf("Rae Orbit"));
  });
});
