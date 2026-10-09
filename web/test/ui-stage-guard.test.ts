/*
 * Source guards on the window half of the stage doors: what the pull request
 * panel does with a staged request sends nothing before the person answers, and
 * every prepared dialog is marked as written by an agent and holds its confirm
 * button back for a moment. Read as text, like the other guards in this folder;
 * the ceiling is the same (a writer reached through a computed name is not seen).
 *
 * The behaviour of the handlers and the plan is ui-stage.test.ts; the level
 * model's own guard (no level 3 handler calls a writer) is ui-level-guards.test.ts
 * and reads these doors on its own.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** Text from `start` to the first `end` after it, or an error that names what moved. */
export function slice(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`the panel no longer has ${JSON.stringify(start)} where this guard looks`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`the panel no longer has ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return src.slice(a, b);
}

const panel = read("components/PrPanel.tsx");
/** The writers a staged dialog must never reach on its own. */
const WRITERS = ["prMerge", "prComment", "prReview", "prReviewWith", "issueComment", "clickupCard", "clickupStatus", "clickupComment", "prClose", "prReviewers"];

/** The calls the staged-request effect may make, and nothing else: a refactor that makes
 *  it call a new function has to come here and say why that one cannot send. */
const EFFECT_MAY_CALL = new Set([
  "useEffect", "exec", "Number", "toLowerCase", "clearStage", "flash", "planStage", "doMerge", "readStash", "writeStash", "markPrepared",
  "setTab", "setMyReview", "stageCardMove", "trim", "toString",
]);

/** What is wrong with the staged-request block, as sentences. Empty is clean. */
export function drainViolations(drain: string): string[] {
  const bad: string[] = [];
  const c = code(drain);
  const eff = c.indexOf("useEffect(");
  const mv = c.indexOf("const stageCardMove");
  if (eff < 0 || mv < 0) return ["the block no longer has its effect and its card move where this guard looks"];
  // The effect may call only what is on the list. A writer is not on it by construction, and
  // neither is a panel-local one (arming auto-merge, closing, replying, resolving, applying).
  const effectful = c.slice(eff);
  for (const m of effectful.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!EFFECT_MAY_CALL.has(m[1]!) && !["if", "function", "async"].includes(m[1]!)) bad.push(`the staged-request effect calls ${m[1]}, which is not on its list`);
  }
  for (const w of WRITERS) if (new RegExp(`\\b${w}\\b`).test(effectful)) bad.push(`the staged-request effect names the writer ${w}`);
  // The card move writes, and only after the person's yes.
  const move = c.slice(mv, eff);
  const ask = move.indexOf("await ask(");
  const said = move.indexOf("if (!said) return");
  if (ask < 0) bad.push("the card move never asks");
  if (said < ask) bad.push("the card move does not stop on a no right after asking");
  for (const w of WRITERS) {
    const at = move.indexOf(`api.${w}(`);
    if (at >= 0 && (said < 0 || at < said)) bad.push(`the card move calls ${w} before the person has said yes`);
  }
  if (!/preparedBy:\s*by/.test(move)) bad.push("the card move's dialog does not say who prepared it");
  return [...new Set(bad)];
}

describe("the panel's staged requests send nothing before the person answers", () => {
  const drain = slice(panel, "const stageReq = useSyncExternalStore", "   * Close, or reopen a closed one.");

  it("the effect and the card move are clean", () => expect(drainViolations(drain)).toEqual([]));

  it("the merge is asked through the same dialog, and api.prMerge comes after its answer", () => {
    const run = slice(panel, "const runMerge = async", "const doAutoMerge");
    const choice = run.indexOf("if (!choice) return");
    expect(choice).toBeGreaterThan(0);
    expect(run.indexOf("api.prMerge(")).toBeGreaterThan(choice);
    expect(run).toContain("prefill,");
    // And the guard dialog still comes first, as for a click.
    expect(run.indexOf("confirmMergeGuard")).toBeLessThan(run.indexOf("askMerge("));
  });

  it("the effect serves a request only for the pull request and repository it named", () => {
    expect(drain).toMatch(/detail\.number !== r\.a\.number/);
    expect(drain).toMatch(/mine\[1\]!\.toLowerCase\(\) !== r\.a\.repo\.toLowerCase\(\)/);
    expect(drain).toContain("detail.url");
    // Only on screen, loaded, and with no question already being answered.
    expect(drain).toContain("if (!active || detailStale || askOpen || mergeOpen) return;");
    expect(drain).toContain("planStage(r, detail)");
    expect(drain).toContain("if (readOnly)");
  });

  it("proves itself: a card move that writes before asking, or an effect that submits, is red", () => {
    const early = drain.replace("const said = await ask({", "await api.clickupCard(task.id, { status: target.status }, task.updated);\n    const said = await ask({");
    expect(drainViolations(early).join(" ")).toContain("clickupCard before the person has said yes");
    const submits = drain.replace("setTab(\"review\");", "setTab(\"review\"); void submitReview(x.a.verdict, x.a.body ?? \"\");");
    expect(drainViolations(submits).join(" ")).toContain("calls submitReview");
    const names = drain.replace("setTab(\"conversation\");", "setTab(\"conversation\"); void api.prComment(root, 1, \"x\");");
    expect(drainViolations(names).join(" ")).toContain("prComment");
    // The panel-local writers the denylist alone did not see: each is a way to send.
    for (const fn of ["doAutoMerge", "doClose", "doReply", "doResolve", "doApplySuggestion", "doReviewers", "act"]) {
      const local = drain.replace("setTab(\"conversation\");", `setTab("conversation"); void ${fn}();`);
      expect(drainViolations(local).join(" "), fn).toContain(`calls ${fn}`);
    }
    // A moved block is a red guard, not a vacuous one.
    expect(drainViolations(drain.replace("useEffect(", "useLayoutEffect(")).length).toBeGreaterThan(0);
    expect(drainViolations("const nothing = 1;")).toEqual(["the block no longer has its effect and its card move where this guard looks"]);
    const noask = drain.replace(/await ask\(\{/, "await Promise.resolve({");
    expect(drainViolations(noask).join(" ")).toContain("never asks");
  });
});

describe("every prepared dialog says who wrote it and holds its confirm back", () => {
  it("ConfirmDialog: the line, the focus on Cancel, Enter dead, the button held", () => {
    const s = code(read("components/ConfirmDialog.tsx"));
    expect(s).toContain("preparedLine(pending.preparedBy)");
    expect(s).toMatch(/pending\.cancelFocus \|\| pending\.preparedBy\) cancelRef/);
    expect(s).toMatch(/e\.key === "Enter" && !pending\.cancelFocus && !pending\.preparedBy/);
    expect(s).toMatch(/disabled=\{\(isPrompt && !text\.trim\(\)\) \|\| held\}/);
    expect(s).toContain("useStageHold(!!pending?.preparedBy");
  });
  it("MergeDialog: the line, the chord and the button held; the fields are inputs, not rendered markdown", () => {
    const s = code(read("components/MergeDialog.tsx"));
    expect(s).toContain("preparedLine(pending.prefill.by)");
    expect(s).toMatch(/if \(!held && \(rebase \|\| subject\.trim\(\)\)\) submit\(\)/);
    expect(s).toMatch(/disabled=\{\(!rebase && !subject\.trim\(\)\) \|\| held\}/);
    expect(s).toContain("useStageHold(!!pending?.prefill");
    expect(s).toMatch(/pending\.prefill\?\.subject \?\? mergeSubject/);
    expect(s).not.toContain("dangerouslySetInnerHTML");
  });
  it("Composer: the line, send guarded, both buttons held, cleared on send", () => {
    const c = code(panel.slice(panel.indexOf("function Composer(")));
    expect(c).toContain("preparedLine(preparedBy.by)");
    expect(c).toMatch(/if \(!text\.trim\(\) \|\| sending \|\| held\) return/);
    expect((c.match(/sending \|\| busy \|\| held \|\| !text\.trim\(\)/g) ?? []).length).toBe(2);
    expect(c).toContain("clearPrepared(stash)");
  });
  it("the review form: the line and Submit held, in the review tab itself", () => {
    const tab = code(panel.slice(panel.indexOf("function ReviewTab(")));
    expect(panel.indexOf("function ReviewTab(")).toBeGreaterThan(0);
    expect(tab).toContain("preparedLine(preparedBy.by)");
    expect(tab).toMatch(/disabled=\{busy \|\| holdReview \|\|/);
    expect(code(panel)).toContain("clearPrepared(`review|${detail.url}`)");
  });
  it("the Files rail cannot submit a prepared review: it sends the person to the tab that shows the line", () => {
    const c = code(panel);
    const at = c.indexOf("preparedFor(`review|${detail.url}`)");
    expect(at).toBeGreaterThan(0);
    expect(c.indexOf("void submitReview(myReview.verb, myReview.body)", at)).toBeGreaterThan(at);
  });
  it("staging never merges into the person's own text or flips their verdict", () => {
    const drain = slice(panel, "const stageReq = useSyncExternalStore", "   * Close, or reopen a closed one.");
    expect(drain).toContain("if (readStash(k).trim())");
    expect(drain).toContain("if (hasReviewDraft)");
    expect(drain).not.toMatch(/had\b/);
  });
  it("the staged text is only ever a field's value or plain text, never rendered as markdown or HTML before the person has it", () => {
    for (const f of ["components/ConfirmDialog.tsx", "components/MergeDialog.tsx", "lib/stageHold.ts", "lib/stageIntent.ts", "lib/stagePlan.ts"]) {
      expect(read(f), f).not.toContain("dangerouslySetInnerHTML");
    }
    const drain = slice(panel, "const stageReq = useSyncExternalStore", "   * Close, or reopen a closed one.");
    expect(drain).not.toMatch(/<Md\b|innerHTML/);
  });
});

describe("the modules a staged request travels through reach no network", () => {
  for (const f of ["lib/stageIntent.ts", "lib/stagePlan.ts", "lib/stageHold.ts", "lib/prJump.ts"]) {
    it(`${f} does not fetch, post or import the api`, () => {
      const s = code(read(f));
      expect(s).not.toMatch(/\bfetch\s*\(|\bpost\s*[<(]|XMLHttpRequest|sendBeacon|new WebSocket|from "\.\/api\.ts"|\bapi\./);
    });
  }
});

describe("the merge guard comes before the merge dialog", () => {
  // The dialog asks "merge?"; the guard is what says a review is still pending or a check is red.
  // Without it the person answers the first question without the second one being asked.
  it("runMerge asks confirmMergeGuard before askMerge, and doAutoMerge before it arms", () => {
    const run = slice(panel, "const runMerge = async", "const choice = await askMerge");
    expect(code(run)).toContain("await confirmMergeGuard(detail, ask");
    expect(code(run)).toContain("return;");
    const auto = slice(panel, "const doAutoMerge = async", "api.prMerge(");
    expect(code(auto)).toContain("if (!(await confirmMergeGuard(detail, ask))) return;");
  });
});
