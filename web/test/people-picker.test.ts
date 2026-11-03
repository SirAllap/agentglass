/*
 * ONE people picker for reviewers and assignees, and the card half under it.
 *
 * There is no renderer under `bun test`, so what can be asserted about the
 * screens is asserted against their source: that every way in still ends in the
 * one picker, that the keyboard and focus rules hold, and that the flow applies
 * through the plan and reports per system. The decisions themselves are pinned
 * on the pure modules (pr-ask-who, pr-hand-over, pr-apply-result, pr-apply-run,
 * pr-people-source, pr-card-match).
 */
import { describe, expect, test } from "bun:test";

const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const panel = await read("components/PrPanel.tsx");
const picker = await read("components/workspace/PeoplePicker.tsx");
const flow = await read("components/PrAskPicker.tsx");

/** `usePrFieldPicker` to the helper after it. */
const hook = panel.slice(panel.indexOf("function usePrFieldPicker("), panel.indexOf("function CardStatusPick("));

describe("every way into the picker still ends in the one picker", () => {
  test("reviewers and assignees both draw PeoplePicker, through the flow; labels and milestone keep the list", () => {
    expect(hook).toContain('picker.field === "reviewers" || picker.field === "assignees"');
    expect(hook).toContain("<AskPickerHost");
    expect(hook.match(/<FieldPicker/g)?.length).toBe(2);
    expect(hook).toContain('title="Apply labels"');
    expect(hook).toContain('title="Set milestone"');
    expect(flow).toContain("<PeoplePicker");
  });

  test("the masthead, the sidebar pencil and the merge box all open it", () => {
    expect(panel).toContain("const askReviewers = (from?: DOMRect | null) => fieldPicker.openAt(\"reviewers\", from);");
    expect(panel).toContain("onEditField={fieldPicker.open}");
    expect(code(panel)).toMatch(/onReviewers=\{askReviewers\}/);
    expect(code(panel)).toMatch(/onAskReview=\{askReviewers\}/);
  });

  test("Hand over opens it with the card half on, and Request a review without", () => {
    expect(panel).toContain('const askHand = (from?: DOMRect | null) => fieldPicker.openAt("reviewers", from, true);');
    expect(panel).toContain('case "hand": askHand(); break;');
    expect(panel).toContain('case "reviewers": askReviewers(); break;');
    expect(flow).toContain('useState<AskMode>(handOver ? "reviewers" : startMode)');
  });

  test("nothing that could be done before has lost its door: re-request and remove go to the same endpoints", () => {
    expect(hook).toContain("api.prReviewers(root, d.number, add, [])");
    expect(hook).toContain("api.prAssignees(root, d.number, add, [])");
    expect(hook).toContain("api.prReviewers(root, d.number, [login], [])");
    expect(hook).toContain("api.prReviewers(root, d.number, [], [login])");
    expect(hook).toContain("api.prAssignees(root, d.number, [], [login])");
    expect(hook).toContain("\"Re-request did not go out\"");
    expect(picker).toContain("onRerequest");
    expect(picker).toContain("onRemoveHeld");
  });

  test("an already-asked row names where they stand under the login, as the tag beside it does", () => {
    const held = picker.slice(picker.indexOf("if (r.held) {"), picker.indexOf("const on = r.picked;"));
    expect(held).toContain("{r.sub && <small");
    expect(held).not.toContain("!tag && r.sub");
  });
  test("a team is sent as org/team and never put on the optimistic reviewer list as a person", () => {
    expect(flow).toContain('(s.teams ?? []).map((t) => t.replace(/^@/, ""))');
    expect(hook).toContain('add.filter((x) => !x.includes("/"))');
  });

  test("the options are read once on open and can be read again, instead of an empty list after a failure", () => {
    expect(hook).toContain("const ensureOptions = useCallback(async (again = false) => {");
    expect(hook).toContain("retry: () => { void ensureOptions(true); }");
    expect(hook).toContain('load: loading ? "loading" : failed ? "error" : "ready"');
  });
});

describe("the picker's keyboard and focus", () => {
  test("the combobox owns the arrows, Enter, Home/End on an empty box, Backspace and Esc", () => {
    expect(picker).toContain('role="combobox"');
    expect(picker).toContain("aria-activedescendant");
    expect(picker).toContain('e.key === "Home" || e.key === "End"');
    expect(picker).toContain('e.key === "Backspace"');
    expect(picker).toContain('e.key !== "Escape"');
  });

  test("focus goes to the search box after the Portal is in the document, and back to the opener on the way out", () => {
    expect(picker).toMatch(/requestAnimationFrame\(\(\) => input\.current\?\.focus\(\)\)/);
    expect(code(picker)).not.toMatch(/autoFocus(?=[\s>/])/);
    expect(picker).toContain("Whoever opened it gets the focus back.");
    expect(picker).toContain("el.isConnected");
  });

  test("it is a layer with an owner, so Esc closes the top one only", () => {
    expect(picker).toContain("useCloseWithOwner(onClose, { from: box });");
  });

  test("while the apply is running nothing outside or inside can close it or change it", () => {
    expect(picker).toContain("canClose.current");
    expect(flow).toContain('dismissible={result.phase !== "working"}');
    expect(flow).toContain("locked={locked}");
  });

  test("it opens from the pressed button: the origin of the grow is the anchor's side", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url).pathname).text();
    const at = css.indexOf(".agx-pp {");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("transform-origin: top right");
    expect(rule).toMatch(/160ms/);
    expect(css).toMatch(/prefers-reduced-motion[^{]*\{[^}]*\.agx-pp/);
  });
});

describe("the flow applies through the plan and answers per system", () => {
  test("one Done, one plan, one result row per system, and only the failed set is sent again", () => {
    expect(flow).toContain("const plan = useMemo(() => handOverPlan({");
    expect(flow).toContain("const result = useMemo(() => applyResult(plan, out), [plan, out]);");
    expect(flow).toContain("run(r.retry)");
    expect(flow).toContain("setOut((o) => startSteps(o, ids));");
  });

  test("when everything went through it closes after the beat and says what it did, once", () => {
    expect(flow).toContain("if (result.closeAfterMs === null) return;");
    expect(flow).toContain('deps.note(true, result.toast ?? "");');
  });

  test("the tracker kinds are told apart: ClickUp in one write, Jira in two stamped calls", () => {
    expect(flow).toContain('if (sd.kind === "clickup") {');
    expect(flow).toContain('} else if (sd.kind === "jira") {');
    expect(flow).toContain("TRACKERS.jira.setPeople!(task,");
    expect(flow).toContain("TRACKERS.jira.setStatus(task, opt)");
  });

  test("the card's own people are drawn open, one hairline under the list, with no fold", () => {
    expect(picker).toContain("{children}");
    expect(flow).toContain('role="radiogroup" aria-label="Card status"');
    expect(flow).toContain("Add someone to the card");
    expect(flow).toContain("Same people as ${mode}");
  });

  test("a tracker that is not connected is said, not drawn as an empty half", () => {
    expect(flow).toContain("No tracker is connected for this repo, so no card is updated here. Connect one in Settings.");
    expect(flow).toContain('case "unknown": return null;');
  });
});

/* The dialog is a flex column with a max-height. At that height every child shrank, and the summary line (min-height 18, 6px of padding a side)
   shrank to 18px with its second line spilling over the Cancel and Done row: seen with the "Link bob to..." box open on a hand-over. */
describe("the picker's rows never shrink when the dialog hits its height", () => {
  test("the dialog's children keep their height and the dialog scrolls instead", async () => {
    const css = await read("index.css");
    expect(css).toMatch(/\.agx-pp > \* \{ flex-shrink: 0; \}/);
  });
  test("its own cap is 880, above the 857px a hand-over takes with the card half and a link box open", () => {
    expect(picker).toContain("const PP_MAX_H = 880;");
    expect(picker).toContain("maxHeight: `min(${PP_MAX_H}px, calc(100vh - ${top + 12}px))`");
  });
  test("and the summary with Cancel and Done stays on the dialog's bottom edge while it scrolls", () => {
    expect(picker).toMatch(/data-pp-footer className="sticky [^"]*"[^>]*>\{footer\}<\/div>/);
  });
});
