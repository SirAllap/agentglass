/*
 * The Quick setup card on the Orchestration page: drawn from what it is
 * handed, and its source held to what it promises. "Check my setup" asks
 * nothing and writes nothing; a refused save leaves nothing behind to go back
 * to; the cards are in the page before everything else.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView } = await import("../src/components/orchestration/OrchestrationPane.tsx");
const { Filter } = await import("../src/components/SettingRow.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { OWN_SETTING, SCOPE_KEY, recallScope, rememberScope, scopeSentence, openingScope, appliedLine, cardUndo, presetDiagram, undoPolicy, applyPreset, backAvailable, backOf, presetInForce, presetOffers, scopeWords } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const quick = strip(readFileSync(join(DIR, "QuickSetup.tsx"), "utf8"));
const copy = strip(readFileSync(join(DIR, "orchestrationCopy.ts"), "utf8"));
const title = (id: string) => agentProvider(id)!.title;

const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const OLD = engine("hermes", {
  version: "0.21.0", min: "0.21.4", versionOk: false,
  roles: { worker: { ok: false, why: "old" }, orchestrator: { ok: false, why: "old" } },
});
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: [engine("claude"), engine("opencode"), OLD], states: [], seat: null,
    notes: {}, busy: false, onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));

/** The markup of one card's row, from its anchor to the next. */
const rowOf = (html: string, label: string): string => {
  const at = html.indexOf(`data-row="${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  expect(at, label).toBeGreaterThan(-1);
  const next = html.indexOf('data-row="', at + 10);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the card on the page", () => {
  test("it is the first card, and every preset says what it sets", () => {
    const html = view();
    expect(html.indexOf("Start from a preset")).toBeGreaterThan(-1);
    expect(html.indexOf("Start from a preset")).toBeLessThan(html.indexOf("Fine-tune who does what"));
    for (const o of presetOffers([engine("claude"), engine("opencode")])) {
      const row = rowOf(html, o.title);
      for (const line of o.says) expect(row).toContain(line.replace(/'/g, "&#x27;"));
      expect(row).toContain(o.confirm);
    }
  });
  test("an engine that is missing disables the preset, says which and links to Agent engines", () => {
    const html = view({ readiness: [engine("claude"), OLD] });
    const row = rowOf(html, `${title("claude")} orchestrates, others work`);
    expect(row).toContain(`Needs an engine besides ${title("claude")} that can work: ${title("hermes")} needs an update.`);
    expect(row).toContain("See Agent engines");
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*>Use this setup<\/button>/);
    // the one that needs only Claude stays pressable
    expect(rowOf(html, `All workers on ${title("claude")}`)).not.toMatch(/disabled=""[^>]*>Use this setup</);
  });
  test("before the probe answers every Apply is disabled and Check my setup too", () => {
    const html = view({ readiness: null });
    expect((html.match(/<button[^>]*disabled=""[^>]*>Use this setup<\/button>/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check my setup<\/button>/);
  });
  test("a project on the general setting cannot be written, and says what to do", () => {
    const html = view({ root: "/work/orbit", scope: "global" });
    expect(html).toContain("Set it for this project first, or pick All projects.");
    expect((html.match(/<button[^>]*disabled=""[^>]*>Use this setup<\/button>/g) ?? []).length).toBe(3);
  });
  test("the server's sentence for a refusal sits in the card", () => {
    const html = view({ notes: { quick: "policy.workerDefault: is wider than the most the main agent may allow; lower the default or raise that limit on purpose" } });
    expect(html.indexOf("is wider than the most")).toBeGreaterThan(html.indexOf("Start from a preset"));
    expect(html.indexOf("is wider than the most")).toBeLessThan(html.indexOf("Fine-tune who does what"));
  });
});

describe("the card's source", () => {
  test("applying goes through the page's save and records the way back only after it saved", () => {
    const at = quick.indexOf("const apply = async");
    const body = quick.slice(at, quick.indexOf("\n  };", at));
    expect(body).toContain("p.onSave(next, \"quick\")");
    expect(body.indexOf("if (err) return;")).toBeGreaterThan(-1);
    expect(body.indexOf("writeBack(")).toBeGreaterThan(body.indexOf("if (err) return;"));
  });
  test("going back removes only what the preset added from the policy as it is now, and forgets it only after it saved", () => {
    const at = quick.indexOf("const undo = async");
    const body = quick.slice(at, quick.indexOf("\n  };", at));
    expect(body).toContain("p.onSave(undoPolicy(p.policy, back), \"quick\")");
    expect(body.indexOf("writeBack(p.root, null)")).toBeGreaterThan(body.indexOf("if (err) return;"));
    expect(quick).toContain("{BACK_LABEL}");
    expect(quick).toContain("cardUndo(");
  });
  test("after another edit the way back is dropped and the card says so", () => {
    expect(quick).toContain("{BACK_GONE}");
    const end = quick.indexOf("}, [back, pending");
    const body = quick.slice(quick.lastIndexOf("useEffect", end), end);
    expect(body).toContain("backAvailable(back, p.policy)");
    expect(body).toContain("setGone(true)");
  });
  test("the way back is recorded against the policy the page holds after the save", () => {
    expect(quick).toContain("after: JSON.stringify(p.policy)");
  });
  test("Check my setup makes no request, no save and starts nothing", () => {
    const at = quick.indexOf("Check my setup</Button>");
    const click = quick.slice(quick.lastIndexOf("<Button", at), at);
    expect(click).toContain("setCheck(checkSetup(");
    expect(click).not.toMatch(/onSave|api\.|fetch|apply|undo/);
    const fn = copy.slice(copy.indexOf("export function checkSetup("));
    expect(fn).not.toMatch(/\bapi\b|fetch|localStorage|XMLHttp|await |onSave/);
  });
  test("the storage is read inside a guard", () => {
    expect(quick).toMatch(/try \{[\s\S]*localStorage\.getItem[\s\S]*\} catch/);
    expect(quick).toMatch(/try \{[\s\S]*localStorage\.setItem[\s\S]*\} catch/);
  });
});

describe("an applied preset says so", () => {
  const ready = [engine("claude"), engine("opencode")];
  test("a preset in force is active, and the others stay applicable", () => {
    const applied = applyPreset(base(), "claude-orchestrates", ready)!;
    expect(presetInForce(applied, "claude-orchestrates", ready)).toBe(true);
    expect(presetInForce(base(), "claude-orchestrates", ready)).toBe(false);
    const offers = presetOffers(ready, applied);
    expect(offers.find((o) => o.id === "claude-orchestrates")!.active).toBe(true);
    expect(offers.find((o) => o.id === "all-on-claude")!.active).toBe(false);
    expect(presetOffers(ready, base()).some((o) => o.active)).toBe(false);
  });
  test("the card shows a check and the scope instead of an Apply", () => {
    const applied = applyPreset(base(), "claude-orchestrates", ready)!;
    const row = rowOf(view({ policy: applied, readiness: ready }), "Claude Code orchestrates, others work");
    expect(row).toContain("Applied for all projects");
    expect(row).not.toMatch(/>Use this setup</);
    expect(rowOf(view({ policy: applied, readiness: ready }), "All workers on Claude Code")).toMatch(/>Use this setup</);
    expect(scopeWords("/home/me/code/orbit")).toBe("orbit");
  });
  test("the line under the card says what changed and where the rule is", () => {
    expect(appliedLine("Quick setup: x", true, "/w/orbit")).toBe("Saved for orbit. Nothing running was moved.");
    expect(appliedLine("Quick setup: x", true)).toBe("Saved for all projects. Nothing running was moved.");
    expect(appliedLine("Quick setup: x", false)).toContain("nothing changed");
    expect(quick).toContain("See it in Conditions below");
    expect(quick).toContain("scrollIntoView");
  });
  test("pressing a preset already in force saves nothing and keeps the way back", () => {
    const at = quick.indexOf("const apply = async");
    const body = quick.slice(at, quick.indexOf("\n  };", at));
    const guard = body.indexOf("presetInForce(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("p.onSave("));
    expect(body.slice(guard, body.indexOf("p.onSave("))).toContain("return;");
    expect(guard).toBeLessThan(body.indexOf("writeBack("));
  });
  test("the way back stays while the stored policy is what applying left", () => {
    const applied = applyPreset(base(), "claude-orchestrates", ready)!;
    const back = backOf(base(), applied, "t");
    expect(backAvailable(back, applied)).toBe(true);
    expect(backAvailable(back, applyPreset(applied, "claude-orchestrates", ready)!)).toBe(true);
  });
});

describe("the scope is remembered", () => {
  const PANE = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
  test("the last choice wins while it is on offer, else the project the app shows, else all projects", () => {
    const ps = ["/w/orbit", "/w/acme"];
    expect(openingScope("/w/acme", ps, "/w/orbit")).toBe("/w/acme");
    expect(openingScope("", ps, "/w/orbit")).toBe("");
    expect(openingScope(null, ps, "/w/orbit")).toBe("/w/orbit");
    expect(openingScope("/w/gone", ps, "/w/orbit")).toBe("/w/orbit");
    expect(openingScope(null, ps, null)).toBe("");
    expect(openingScope(null, ps, "/w/other")).toBe("");
  });
  test("a window that leaves the page and comes back opens on the project it left", () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(recallScope(store)).toBeNull();
    rememberScope(store, "/w/acme");
    expect(recallScope(store)).toBe("/w/acme");
    expect(kept.get(SCOPE_KEY)).toBe("/w/acme");
    rememberScope(store, "");
    expect(recallScope(store)).toBe("");
    expect(openingScope(recallScope(store), ["/w/orbit"], "/w/orbit")).toBe("");
  });
  test("a store that refuses reads as never chosen, and writing to it breaks nothing", () => {
    const refusing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(recallScope(refusing)).toBeNull();
    expect(() => rememberScope(refusing, "/w/acme")).not.toThrow();
    expect(recallScope(null)).toBeNull();
    expect(() => rememberScope(null, "/w/acme")).not.toThrow();
  });
  test("the page opens on the remembered scope and stores each choice", () => {
    expect(PANE).toContain("useState(() => recallScope(storage()) ?? \"\")");
    expect(PANE).toContain("rememberScope(storage(), r)");
    expect(PANE).toContain("onRoot={pick}");
    expect(PANE).toContain("if (!chosen.current) setRoot(openingScope(");
  });
  test("a project with its own setting has a dot and says so in its title", () => {
    const html = view({ projects: ["/w/orbit", "/w/acme"], overrides: ["/w/orbit"] });
    expect(html).toContain(`/w/orbit — ${OWN_SETTING}`);
    expect(html).not.toContain(`/w/acme — ${OWN_SETTING}`);
  });
});

describe("the side sheet opens where the person is looking", () => {
  const PANE = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
  const SHEET = strip(readFileSync(join(DIR, "RuleForm.tsx"), "utf8"));
  test("the sheet is fixed over the page, so it needs no scroll to be seen, and Esc and the scrim close it", () => {
    const at = SHEET.indexOf("export function RuleSheet(");
    const body = SHEET.slice(at);
    expect(body).toContain('className="fixed top-0 right-0 bottom-0');
    expect(body).toContain('e.key === "Escape"');
    expect(body).toContain("onClick={onCancel}");
    expect(body).toContain("nameRef.current?.focus({ preventScroll: true })");
  });
  test("every button that opens it records itself, and closing returns the focus to it", () => {
    for (const label of ["Add a fallback rule", ">Edit<", "Add a condition<"]) expect(PANE, label).toContain(label);
    expect((PANE.match(/openSheet\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const at = PANE.indexOf("const openSheet =");
    expect(PANE.slice(at, at + 260)).toContain("opener.current = from");
    expect(PANE).toContain("opener.current.focus()");
  });
  test("the sheet is not drawn inside the card that lists the conditions", () => {
    const card = PANE.slice(PANE.indexOf('<SettingsCard title="Conditions"'), PANE.indexOf('<SettingsCard title={SAFETY.title}'));
    expect(card).not.toContain("RuleSheet");
  });
});

describe("a preset card shows what changes", () => {
  const ready = [engine("claude"), engine("opencode"), engine("hermes")];
  test("the diagram is one row per role the preset names: the engines now, then the engines after", () => {
    const o = presetOffers(ready, base()).find((x) => x.id === "claude-orchestrates")!;
    const rows = presetDiagram(base(), o.workers);
    expect(rows.map((r) => r.word)).toEqual(["Scouts", "Builders", "Reviewers", "Verifiers"]);
    expect(rows[1]).toMatchObject({ role: "builder", before: ["claude"], after: ["opencode", "hermes"] });
  });
  test("a preset that moves only builders draws only builders; a blocked one draws nothing", () => {
    const plan = presetOffers(ready, base()).find((x) => x.id === "save-my-plan")!;
    expect(presetDiagram(base(), plan.workers).map((r) => r.role)).toEqual(["builder"]);
    expect(presetDiagram(base(), presetOffers(null, base())[0]!.workers)).toEqual([]);
  });
  test("each card draws Before and After, with the neutral letters", () => {
    const row = rowOf(view({ readiness: ready }), `${title("claude")} orchestrates, others work`);
    expect(row).toContain("Before");
    expect(row).toContain("After");
    expect(row).toContain(">O<");
    expect(row).toContain(">H<");
  });
  test("the applied card has the green edge and the Applied word; the others do not", () => {
    const applied = applyPreset(base(), "claude-orchestrates", ready)!;
    const html = view({ policy: applied, readiness: ready });
    expect(rowOf(html, `${title("claude")} orchestrates, others work`)).toContain("border:1px solid var(--success)");
    expect(rowOf(html, `All workers on ${title("claude")}`)).not.toContain("border:1px solid color-mix(in srgb, var(--success)");
  });
});

describe("undo", () => {
  const ready = [engine("claude"), engine("opencode")];
  test("it sits on the card that was applied, only while the way back holds", () => {
    const next = applyPreset(base(), "claude-orchestrates", ready)!;
    const back = backOf(base(), next, "T");
    expect(cardUndo(back, next, "T")).toBe(true);
    expect(cardUndo(back, next, "Other")).toBe(false);
    expect(cardUndo(null, next, "T")).toBe(false);
    expect(cardUndo(back, base(), "T")).toBe(false);
  });
  test("a policy the server stored, with its keys in the server's order, still counts as in force", () => {
    // measured: the server answers a rule as id, name, when, enabled; the page builds it as id, name, enabled, when
    const built = applyPreset(base(), "claude-orchestrates", ready)!;
    const stored = JSON.parse(JSON.stringify(built)) as typeof built;
    stored.rules = stored.rules.map((r) => ({ id: r.id, name: r.name, when: r.when, enabled: r.enabled, workers: r.workers }));
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(built));
    expect(presetInForce(stored, "claude-orchestrates", ready)).toBe(true);
    expect(presetOffers(ready, stored).find((o) => o.id === "claude-orchestrates")!.active).toBe(true);
  });
  test("pressing the applied preset again changes nothing, so the undo is still there and still goes back", () => {
    const first = applyPreset(base(), "claude-orchestrates", ready)!;
    const back = backOf(base(), first, "T");
    expect(presetInForce(first, "claude-orchestrates", ready)).toBe(true);
    // the press saves nothing: the stored policy is the one the way back was recorded against
    expect(cardUndo(back, first, "T")).toBe(true);
    expect(JSON.stringify(undoPolicy(first, back))).toBe(JSON.stringify(base()));
  });
  test("applying a second preset replaces the way back with its own, and undoing it leaves the first in place", () => {
    const a = applyPreset(base(), "claude-orchestrates", ready)!;
    const b = applyPreset(a, "save-my-plan", ready)!;
    const backB = backOf(a, b, "B");
    expect(cardUndo(backB, b, "B")).toBe(true);
    expect(JSON.stringify(undoPolicy(b, backB))).toBe(JSON.stringify(a));
  });
  test("the toast says what was saved, where, and carries the Undo; it has no timer", () => {
    expect(quick).toContain("appliedLine(result.ruleName, result.changed, p.root)");
    const at = quick.indexOf('role="status"');
    const toast = quick.slice(at, quick.indexOf("</p>", at) > at ? quick.indexOf("</div>", at) : at + 800);
    expect(toast).toContain("BACK_LABEL");
    expect(/\bset(Timeout|Interval)\b/.test(quick)).toBe(false);
  });
});

describe("the project bar", () => {
  const BAR = strip(readFileSync(join(DIR, "ScopeBar.tsx"), "utf8"));
  test("it is the first thing on the page and sticks to the top of it", () => {
    const html = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "project", overrides: ["/w/orbit"] });
    expect(html.indexOf("data-scope-bar")).toBeGreaterThan(-1);
    expect(html.indexOf("data-scope-bar")).toBeLessThan(html.indexOf("Right now"));
    expect(html).not.toContain("Applies to");
    expect(BAR).toMatch(/className="sticky z-10 /);
    expect(BAR).toContain("--orch-stick");
  });
  test("it sticks under the sticky page header, at the header's own height, so no card shows above the bar", () => {
    expect(BAR).toContain('top: "var(--agx-ph-h, 0px)"');
    const header = readFileSync(join(import.meta.dir, "..", "src", "components", "SettingsPageHeader.tsx"), "utf8");
    expect(header).toContain('setProperty("--agx-ph-h"');
    const modal = readFileSync(join(import.meta.dir, "..", "src", "components", "SettingsModal.tsx"), "utf8");
    expect(modal).toMatch(/className="agx-settings-main [^"]*overflow-y-auto"/);
    expect(modal).not.toMatch(/className="agx-settings-main [^"]*\bpt-8\b/);
  });
  test("the bar's own height is what a scrolled-to card keeps clear of", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "index.css"), "utf8");
    expect(css).toMatch(/\.agx-orch \.agx-scard[^{]*\{[^}]*scroll-margin-top: calc\(var\(--orch-stick, 0px\)/);
  });
  test("a project on the general setting offers to get its own, one with its own offers the way back", () => {
    const inherited = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "global" });
    expect(inherited).toContain("Set for this project");
    expect(inherited).not.toContain("Use the general setting");
    expect(inherited).toContain(scopeSentence("/w/orbit", true, "orbit").tail);
    const own = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "project", overrides: ["/w/orbit"] });
    expect(own).toContain("Use the general setting");
    expect(own).toContain("its own setting. Changes are saved for it only.");
    const all = view();
    expect(all).not.toContain("Set for this project");
    expect(all).toContain("changes here apply to every project without its own.");
  });
  test("a settings search that is listing rows leaves the bar out, and one that is not leaves it in", () => {
    const el = React.createElement(OrchestrationView, {
      policy: base(), scope: "global", root: "", projects: [], readiness: [engine("claude")], states: [], seat: null, notes: {}, busy: false,
      onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {},
    } as OrchestrationViewProps);
    const under = (on: boolean) => renderToStaticMarkup(React.createElement(Filter.Provider, { value: { on, q: "network", seen() {} } }, el));
    expect(under(true)).not.toContain("data-scope-bar");
    expect(under(false)).toContain("data-scope-bar");
  });
  test("a refusal of the change shows inside the bar", () => {
    const html = view({ projects: ["/w/orbit"], root: "/w/orbit", notes: { scope: "Could not save." } });
    const bar = html.slice(html.indexOf("data-scope-bar"), html.indexOf("Right now"));
    expect(bar).toContain("Could not save.");
  });
});
