/*
 * The Jira step's confirmation, drawn: how the card moves (both statuses, as
 * the board draws them), one row per block in run order, every person as a face
 * and a name, and what the footer promises before and after the press. The
 * settle after the answer is in jira-step-plan.test.ts; this is what the screen
 * does with it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepDialog, footerLine, titleOf, type StepDialogSpec } from "../src/components/jira/JiraStepDialog.tsx";
import { planRows, settleRows } from "../src/lib/jiraStepPlan.ts";

const lin = { key: "acc-0003", name: "Lin Tester", initials: "LT", avatar: "https://avatar.example/lin.png" };
const rae = { key: "acc-0007", name: "Rae Orbit", initials: "RO" };
const PR = { url: "https://github.com/acme/orbit/pull/2198", title: "Retry the export", number: 2198, author: "octo-ada" };

const spec = (over: Partial<StepDialogSpec> = {}): StepDialogSpec => ({
  verb: "Move to In Review",
  card: { key: "ORBIT-1042", title: "Export fails on retry", status: "In Progress", statusColor: "#2f81f7", assignee: lin },
  blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }, { type: "assign", who: "person", person: { id: rae.key, name: rae.name } }, { type: "comment", text: "Opened {pr}" }, { type: "link" }],
  to: "In Review", asks: { status: false, clear: false, assign: false, comment: false }, moves: [], people: [lin, rae], comment: "", pr: PR, linked: false, writes: true,
  run: async () => ({ ok: true }), ...over,
});
const draw = (s: StepDialogSpec) => renderToStaticMarkup(React.createElement(StepDialog, { spec: s, onDone: () => {} }));

describe("StepDialog before the press", () => {
  const html = draw(spec());

  test("the card and the status it leaves and enters, each as a status pill", () => {
    expect(html).toContain("ORBIT-1042");
    expect(html).toContain("Export fails on retry");
    const strip = html.slice(html.indexOf("data-step-strip"), html.indexOf("What will happen"));
    expect(strip).toContain("IN PROGRESS");
    expect(strip).toContain("IN REVIEW");
    expect(strip).toContain("→");
  });

  test("one row per block, in run order", () => {
    const at = ["Move ORBIT-1042 from In Progress to In Review", "Take Lin Tester off the card", "Assign the card to Rae Orbit", "Comment on ORBIT-1042", "Link pull request #2198 on the card"].map((s) => html.indexOf(s));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/data-row="/g)).toHaveLength(5);
  });

  test("the comment is previewed with its placeholders filled in", () => {
    expect(html).toContain("Opened #2198 Retry the export");
  });

  test("people are a face and a name; one with no picture falls back to initials", () => {
    expect(html).toContain('data-person=""');
    expect(html).toContain("Rae Orbit");
    expect(html).toContain(">RO<");
    expect(html).toContain("Lin Tester");
  });

  test("a row that would change nothing says so", () => {
    expect(html).toContain('data-noop=""');
    expect(html).toContain("Nothing happens here: replaced by giving the card to Rae Orbit");
    const still = draw(spec({ card: { key: "ORBIT-1042", title: "t", status: "In Review", assignee: null }, linked: true, blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "link" }] }));
    expect(still).toContain("Nothing happens here: already in In Review, so this does nothing");
    expect(still).toContain("Nothing happens here: pull request #2198 is already on the card");
    expect(still).toContain("Nothing to change");
    expect(still).toMatch(/<button[^>]*disabled[^>]*>Nothing to change/);
  });

  test("it promises nothing has changed yet, and the button names the action", () => {
    expect(html).toContain("Nothing in Jira has changed yet.");
    expect(html).toContain("Move to In Review, assign Rae Orbit, comment and link the pull request");
  });

  test("it is a modal dialog with a name, and every state glyph has its word", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Move ORBIT-1042 to In Review"');
    expect(html).toContain('title="waiting"');
  });

  test("switched off: it says why, and the button cannot run it", () => {
    const off = draw(spec({ writes: false }));
    expect(off).toContain("Changes in Jira are off: turn them on in Settings to run this.");
    expect(off).toMatch(/<button[^>]*disabled[^>]*>Move to In Review/);
    expect(html).not.toContain("Changes in Jira are off");
  });

  test("a step that asks shows each question, with the people as faces in the choice", () => {
    const asked = draw(spec({
      to: null, asks: { status: true, clear: true, assign: true, comment: true }, comment: "Opened {pr}",
      blocks: [{ type: "move", statusNames: [], ask: true }, { type: "unassign", who: "all", ask: true }, { type: "assign", who: "none", ask: true }, { type: "comment", text: "x", ask: true }],
      moves: [{ key: "21", label: "In Review", toStatus: "In Review", toKind: "other" }],
    }));
    expect(asked).toContain('data-asked=""');
    for (const w of ["Move to", "Take off", "Give it to", "Comment"]) expect(asked).toContain(w);
    expect(asked).toContain("Leave as is");
  });
});

describe("the title and the footer", () => {
  test("the card sits in the middle of a move", () => {
    expect(titleOf("Move to In Review", "ORBIT-1042")).toBe("Move ORBIT-1042 to In Review?");
    expect(titleOf("Hand off", "ORBIT-1042")).toBe("Hand off ORBIT-1042?");
  });

  const rows = planRows({ blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "x" }], card: { key: "ORBIT-1042", title: "t", status: "In Progress", assignee: null }, target: "In Review", choice: {}, linked: null });
  const foot = (answer: Parameters<typeof settleRows>[2]) => footerLine({ phase: "finished", writes: true, answer, settled: settleRows(rows, "finished", answer), card: "ORBIT-1042" });

  test("done says where the card is now", () => {
    expect(foot({ ok: true, blocks: [{ block: "move", state: "done" }, { block: "comment", state: "done" }], task: { status: "In Review" } } as never)).toEqual({ text: "Done. ORBIT-1042 is now In Review.", tone: "good" });
  });

  test("partly done names the block that failed and says nothing was retried", () => {
    const f = foot({ ok: true, blocks: [{ block: "move", state: "done" }, { block: "comment", state: "failed", why: "Jira did not accept the comment" }] });
    expect(f.tone).toBe("warn");
    expect(f.text).toBe("Partly done. Comment on ORBIT-1042 did not go through: Jira did not accept the comment. Nothing was retried.");
  });

  test("a refused run is a plain sentence and says nothing changed", () => {
    const f = foot({ ok: false, error: "Nothing was changed: could not read the card's moves. HTTP 500 <html>" });
    expect(f).toEqual({ text: "Jira would not answer. Nothing in Jira was changed.", tone: "bad" });
  });

  test("everything skipped is not called done", () => {
    expect(foot({ ok: true, blocks: [{ block: "move", state: "skipped", why: "already in In Review" }, { block: "comment", state: "skipped", why: "x" }] }).text).toBe("Nothing needed to change.");
  });
});

/*
 * Rules about source, asserted against source (there is no renderer here that
 * would catch them): a Jira person's picture goes through the proxy helper and
 * never as a raw third-party address, the dialog keeps its keyboard promises,
 * and its motion stops when the person asked for none.
 */
const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const SRC = { dialog: await read("../src/components/jira/JiraStepDialog.tsx"), card: await read("../src/components/StepCard.tsx"), buttons: await read("../src/components/jira/JiraStepButtons.tsx"), css: await read("../src/index.css"), face: await read("../src/components/AssignPicker.tsx") };
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("a person's picture", () => {
  test("a Jira avatar is drawn through the proxy, not as the third-party address", () => {
    const html = renderToStaticMarkup(React.createElement(StepDialog, { spec: spec({ card: { key: "ORBIT-1042", title: "t", status: "To Do", assignee: { ...lin, avatar: "https://secure.gravatar.com/avatar/abc?d=identicon" } } }), onDone: () => {} }));
    expect(html).not.toContain('src="https://secure.gravatar.com');
    expect(html).toContain("/prs/asset?url=https%3A%2F%2Fsecure.gravatar.com%2Favatar%2Fabc");
  });

  test("no step component sets an image source of its own", () => {
    for (const f of [SRC.dialog, SRC.card, SRC.buttons]) expect(code(f)).not.toMatch(/<img\b|\bsrc=/);
    expect(code(SRC.face)).toContain("avatarSrc(m.avatar)");
  });
});

describe("the dialog's promises", () => {
  test("Escape closes it, Tab stays inside, and the focus goes back", () => {
    expect(code(SRC.dialog)).toContain('e.key === "Escape"');
    expect(code(SRC.dialog)).toContain('e.key !== "Tab"');
    expect(code(SRC.dialog)).toContain("before?.focus");
  });

  test("a run in flight cannot be closed from under itself", () => {
    expect(code(SRC.dialog)).toContain('if (phase !== "running") onDone');
  });

  test("it uses the house tokens, not sizes of its own", () => {
    expect(code(SRC.dialog)).toContain("ICON.lg");
    expect(code(SRC.dialog)).toMatch(/var\(--surface-card\)/);
    expect(code(SRC.dialog)).not.toMatch(/\b(width|height): (1[0-9]|2[1-9]),? /);
  });

  test("motion stops when it is reduced: the settle is instant and the spinner is still", () => {
    expect(code(SRC.dialog)).toContain("useReducedMotion");
    expect(code(SRC.dialog)).toContain("if (reduced) { setShown(rows.length); return; }");
    expect(SRC.css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.agx-step-spin \{ animation: none; \} \}/);
  });

  test("a node's colour change is not animated when motion is reduced", () => {
    expect(code(SRC.dialog)).toContain('transition: still ? "none"');
    expect(code(SRC.dialog)).toContain("still={reduced}");
  });

  test("the buttons no longer ask through the plain confirm", () => {
    expect(code(SRC.buttons)).not.toContain("useDialogs");
    expect(code(SRC.buttons)).toContain("useStepDialog");
  });
});
