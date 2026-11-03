/*
 * The one worker editor, without a renderer: its draft and the flow it becomes
 * are pure, so these are the two commitments that matter — a save goes through
 * the flow's validator and a refusal is shown instead of stored, and nothing
 * exists until Add worker is pressed. The section rules are held on the source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globalStubs } from "./stubGlobal.ts";
import { roleById, validateFlow, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { endIndex } from "../src/lib/flowEdit.ts";
import { applyDraft, draftFromTeam, draftOf, freshDraft, REQUIRED_OFF_PATH, reviewerName, SECTIONS, showsReviewer, withFirstStep } from "../src/components/orchestration/flow/workerDraft.ts";

const shipped = (): Flow => ({ ...templateFlow(), blocks: [] });
const stubGlobal = globalStubs();
const f = shipped();
const SRC = join(import.meta.dir, "..", "src", "components", "orchestration", "flow");
const code = (p: string) => readFileSync(join(SRC, p), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("the draft becomes the flow, or the validator's sentence", () => {
  test("a save of an existing role keeps the role's id and passes validateFlow", () => {
    const role = roleById(f, "builder")!;
    const r = applyDraft(f, { ...draftOf(f, role), name: "Builder two", does: "Builds it." }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe("builder");
    expect(roleById(r.flow, "builder")!.name).toBe("Builder two");
    expect(validateFlow(r.flow).ok).toBe(true);
  });

  test("a refusal is the validator's own sentence and the flow is not changed", () => {
    const before = JSON.stringify(f);
    const r = applyDraft(f, { ...draftOf(f, roleById(f, "builder")!), name: "!" }, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("name");
    expect(JSON.stringify(f)).toBe(before);
  });

  test("Required is kept off a role that is not on the path, with the shipped sentence", () => {
    const team = applyDraft(f, { ...freshDraft(f), name: "Security", does: "Looks for what could be abused.", required: true }, { kind: "team" });
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    expect(team.flow.path).not.toContain(team.id);
    expect(roleById(team.flow, team.id)!.required).toBe(false);
    expect(REQUIRED_OFF_PATH).toBe("Only a step on the path can be required. Put this role on the path first.");
  });

  test("a new role on the path lands where the gap was, with the failing arrow the draft names", () => {
    const draft = { ...freshDraft(f), name: "Release notes", does: "Writes the notes.", failTo: "builder", rounds: 4 };
    const r = applyDraft(f, draft, { kind: "path", index: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.path[3]).toBe("release-notes");
    expect(r.flow.edges.find((e) => e.on === "fail" && e.from === "release-notes")).toEqual({ from: "release-notes", to: "builder", on: "fail", maxRounds: 4 });
  });

  test("nothing is created until Add worker: a fresh draft has no id and the flow is untouched", () => {
    const before = JSON.stringify(f);
    const draft = freshDraft(f);
    expect(draft.id).toBe("");
    expect(f.roster.some((r) => r.id === draft.name)).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
  });

  test("Start from a team role fills the draft and keeps it new", () => {
    const from = draftFromTeam(f, "docs", freshDraft(f));
    expect(from.name).toBe("Docs");
    expect(from.prompt).toBe(roleById(f, "docs")!.prompt);
    expect(from.id).toBe("");
  });

  test("the commands a role may run go through the draft and onto the role", () => {
    const role = roleById(f, "builder")!;
    expect(draftOf(f, role).allow).toEqual([]);
    const r = applyDraft(f, { ...draftOf(f, role), allow: ["docker"] }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(roleById(r.flow, "builder")!.allow).toEqual(["docker"]);
    expect(validateFlow(r.flow).ok).toBe(true);
    // A role without one stores no field at all, so nothing reads as "granted everything".
    const plain = applyDraft(f, { ...draftOf(f, role), allow: [] }, null);
    expect(plain.ok && "allow" in roleById(plain.flow, "builder")!).toBe(false);
    // A worker added in this editor carries it too, not only an edited one.
    const made = applyDraft(f, { ...freshDraft(f), name: "CI", does: "Runs the suite.", allow: ["docker"] }, null);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(roleById(made.flow, made.id)!.allow).toEqual(["docker"]);
  });

  test("a command no role may ever be granted is refused at save, with the command named", () => {
    const r = applyDraft(f, { ...draftOf(f, roleById(f, "builder")!), allow: ["docker", "git push"] }, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"git push" is never granted to a worker');
  });

  test("MAIN replaces the first step, and a fallback that repeated it is dropped", () => {
    const chain = [{ engine: "claude", model: "sonnet" }, { engine: "opencode", model: "glm" }, { engine: "codex", model: "gpt" }];
    expect(withFirstStep(chain, "opencode", "glm")).toEqual([{ engine: "opencode", model: "glm" }, { engine: "codex", model: "gpt" }]);
    expect(withFirstStep(chain, "claude", "haiku")).toEqual([{ engine: "claude", model: "haiku" }, { engine: "opencode", model: "glm" }, { engine: "codex", model: "gpt" }]);
    const r = applyDraft(f, { ...freshDraft(f), name: "CI", does: "Runs the suite.", chain: withFirstStep(chain, "opencode", "glm") }, null);
    expect(r.ok).toBe(true);
  });
});

describe("the sections and who checks", () => {
  test("the order is the mockup's: name and look, who, prompt, where, what happens next, may, rules, check", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(["id", "who", "prompt", "place", "path", "may", "rules", "check"]);
    // The mockup's own glyphs, which the icon set is ported from.
    expect(SECTIONS.map((s) => s.icon)).toEqual(["tag", "users", "note", "flag", "loop", "hand", "gauge", "eye"]);
  });

  test("only the reviewing block carries the reviewer's settings", () => {
    expect(showsReviewer(roleById(f, "inspector"))).toBe(true);
    expect(showsReviewer(roleById(f, "builder"))).toBe(false);
    expect(showsReviewer(null)).toBe(false);
    expect(reviewerName(f)).toBe("Inspector");
  });

  test("Escape inside a rule sheet closes the sheet, not the editor", () => {
    // RuleForm's sheet takes Escape and stops it; a capture listener on the window ran first and closed the editor with the sheet's text.
    const src = code("WorkerEditor.tsx");
    expect(src).toContain('window.addEventListener("keydown", key)');
    expect(src).not.toContain('window.addEventListener("keydown", key, true)');
  });

  test("the editor is one dialog for a role, an off-path role and a new one", () => {
    const src = code("WorkerEditor.tsx");
    expect(src).toContain('role="dialog"');
    expect(src).toContain("Nothing exists until you press Add worker");
    expect(src).toContain("applyDraft(p.flow, draft, place)");
    expect(src).toContain("showsReviewer(role)");
    // The mockup's three columns: the section rail, one scrolling column, the live preview.
    expect(src).toContain('className="fe-eh"');
    expect(src).toContain('className="fe-wednav"');
    expect(src).toContain('className="fe-wedscroll fe-wedmain"');
    expect(src).toContain('className="fe-prev"');
    // Name and look is folded for a worker that exists, open while adding.
    expect(src).toContain('<details className="fe-nl" open={false}');
  });

  test("the arrows walk the path, and the preview cannot be pressed", () => {
    const src = code("WorkerEditor.tsx");
    expect(src).toContain('title="Previous role"');
    expect(src).toContain('title="Next role"');
    expect(src).toContain("p.onOpenRole(prevId)");
    expect(src).toContain("p.onOpenRole(nextId)");
    // A picture of the card, never a second set of controls: inert, and its presses do nothing.
    expect(src).toContain('{...({ inert: "" } as object)}');
    expect(src).toContain('className="fe-prevcard"');
  });

  test("the commands a role may run are a box in What it may do, and it writes the draft", () => {
    const src = code("WorkerEditor.tsx");
    expect(src).toContain('id="fe-wed-allow"');
    expect(src).toContain("Extra commands this role may run");
    expect(src).toContain("set({ allow })");
    // What no worker may ever run is named beside the box, from the shipped list rather than typed here.
    expect(src).toContain("NEVER_LIFTABLE");
  });

  test("a role of one's own picks an engine in the mockup's three tiles and ladders its fallbacks", () => {
    const src = code("WorkerEditor.tsx");
    expect(src).toContain('className="fe-eng"');
    expect(src).toContain("If it cannot start, try next");
    expect(src).toContain("<ChainList");
  });

  test("each engine tile carries the mockup's plan line, not the model it would run", async () => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkerEditor } = await import("../src/components/orchestration/flow/WorkerEditor.tsx");
    const h = renderToStaticMarkup(React.createElement(WorkerEditor, {
      project: "orbit", root: "", around: {} as never, flow: f, edit: { kind: "role", id: "qa-only" },
      onClose() {}, onSave() {}, onReviewRounds: async () => true, onOpenRole() {},
    }));
    expect(h).toContain("your Claude plan");
    expect(h).toContain("OpenCode Go plan");
    expect(h).toContain("your Codex plan");
    expect(h).toContain("4 offered · its own default if you pick none");
  });

  test("a fallback is a row with its own engine and model, a Main badge and a drag handle", () => {
    const src = code("ChainEditor.tsx");
    expect(src).toContain("Engine for fallback");
    expect(src).toContain("Model for fallback");
    expect(src).toContain('className="fe-tag">Main');
    expect(src).toContain("draggable");
    expect(src).toContain("Drag to reorder");
    expect(src).toContain("ArrowUp");
    expect(src).not.toContain("PickRow");
  });

  test("the policy role's footer says what is already saved, as the mockup does", async () => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkerEditor } = await import("../src/components/orchestration/flow/WorkerEditor.tsx");
    const h = renderToStaticMarkup(React.createElement(WorkerEditor, {
      project: "orbit", root: "", around: {} as never, flow: f, edit: { kind: "role", id: "builder" },
      onClose() {}, onSave() {}, onReviewRounds: async () => true, onOpenRole() {},
    }));
    expect(h).toContain("Engine and model saved");
    // The edited-prompt chip is not drawn until there is an edit: the mockup's copy is shown, not a false state.
    expect(h).not.toContain("Prompt edited, not saved");
  });

  test("Add a worker opens the editor in new mode, and a team role fills the draft from inside it", () => {
    const editor = code("FlowEditor.tsx");
    // No drawer in front of the modal: the press opens the one editor, as the mockup does.
    expect(editor).toContain('setWorker({ kind: "new", index: endIndex(flow) })');
    expect(editor).not.toContain("AddWorkerSheet");
    // "Start from a team role" fills it through the same draft, so nothing is created until Add worker.
    const wed = code("WorkerEditor.tsx");
    expect(wed).toContain("Start from a team role");
    expect(wed).toContain("Nothing: write my own");
    expect(wed).toContain("draftFromTeam(p.flow, e.target.value, d)");
  });

  test("a new worker's Prompt starts from a team role, and Where it goes says where it lands", async () => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkerEditor } = await import("../src/components/orchestration/flow/WorkerEditor.tsx");
    const h = renderToStaticMarkup(React.createElement(WorkerEditor, {
      project: "orbit", root: "", around: {} as never, flow: f, edit: { kind: "new", index: endIndex(f) },
      onClose() {}, onSave() {}, onReviewRounds: async () => true, onOpenRole() {},
    }));
    expect(h).toContain("Start from a team role");
    expect(h).toContain("Nothing: write my own");
    // The roles the team has off the path, and nothing that is already a step.
    const offPath = f.roster.filter((r) => !f.path.includes(r.id));
    expect(offPath.length).toBeGreaterThan(0);
    expect(h).toContain(`<option value="${offPath[0]!.id}">${offPath[0]!.name}</option>`);
    expect(h).toContain("It goes between Verifier and Landing.");
  });
});

describe("the editor as it is drawn", () => {
  test("a role of one's own gets the engine tiles and the ladder, and a new role gets where it goes", async () => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkerEditor } = await import("../src/components/orchestration/flow/WorkerEditor.tsx");
    const props = { project: "orbit", root: "", around: {} as never, onClose() {}, onSave() {}, onReviewRounds: async () => true, onOpenRole() {} };
    const own = renderToStaticMarkup(React.createElement(WorkerEditor, { ...props, flow: f, edit: { kind: "role", id: "qa-only" } }));
    expect(own).toContain('class="fe-eng"');
    expect(own).toContain("If it cannot start, try next");
    expect(own).toContain("Add a fallback");
    // The three columns and the preview card, which is a picture and not a second editor.
    expect(own).toContain('class="fe-wednav"');
    expect(own).toContain('class="fe-prev"');
    expect(own).toContain("Live preview");
    expect(own).toContain('inert=""');
    expect(own).toContain("Previous role");
    // Name and look is folded for a role that exists: the mockup's one-line summary.
    expect(own).toContain("Rename, icon, colour");
    const made = renderToStaticMarkup(React.createElement(WorkerEditor, { ...props, flow: f, edit: { kind: "new", index: f.path.length } }));
    expect(made).toContain("Where it goes");
    expect(made).toContain("Only in the team");
    expect(made).toContain("Nothing exists until you press Add worker");
    expect(made).toContain("Not added yet");
    // A new role is not on the path yet, so it has no arrows and no Rules section.
    expect(made).not.toContain("Previous role");
    expect(made).not.toContain("Rules that move it");
  });
});

describe("a rule about source: one editor, and the old three surfaces are gone", () => {
  const editor = code("FlowEditor.tsx");
  test("the editor mounts the one WorkerEditor and no old panel or sheet", () => {
    expect(editor).toContain("<WorkerEditor");
    expect(editor).not.toContain("BlockSide");
    expect(editor).not.toContain("RoleSheet");
    expect(editor).not.toContain("AddSheet");
  });
  test("the right panel is a read-only summary that opens the editor", () => {
    expect(editor).toContain("<WorkerPanel");
    expect(code("WorkerPanel.tsx")).toContain("onConfigure");
    expect(code("WorkerPanel.tsx")).not.toContain("<PolicyRoleControls");
  });
  test("the card's Configure, double-click and Enter all open the editor", () => {
    const card = code("WorkerCard.tsx");
    expect(card).toContain("onDoubleClick={p.onOpen}");
    expect(card).toContain('if (e.key === "Enter")');
    expect(card).toContain("p.onConfigure()");
  });
});
