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
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { OWN_SETTING, openingScope, appliedLine, applyPreset, backAvailable, backOf, presetInForce, presetOffers, scopeWords } from "../src/components/orchestration/orchestrationCopy.ts";

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
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
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
    expect(html.indexOf("Quick setup")).toBeGreaterThan(-1);
    expect(html.indexOf("Quick setup")).toBeLessThan(html.indexOf("Applies to"));
    for (const o of presetOffers([engine("claude"), engine("opencode")])) {
      const row = rowOf(html, o.title);
      for (const line of o.says) expect(row).toContain(line.replace(/'/g, "&#x27;"));
      expect(row).toContain(o.confirm.replace(/"/g, "&quot;"));
    }
  });
  test("an engine that is missing disables the preset, says which and links to Agent engines", () => {
    const html = view({ readiness: [engine("claude"), OLD] });
    const row = rowOf(html, `${title("claude")} orchestrates, others work`);
    expect(row).toContain(`Needs an engine besides ${title("claude")} that can work: ${title("hermes")} needs an update.`);
    expect(row).toContain("See Agent engines");
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
    // the one that needs only Claude stays pressable
    expect(rowOf(html, `All workers on ${title("claude")}`)).not.toMatch(/disabled=""[^>]*>Apply</);
  });
  test("before the probe answers every Apply is disabled and Check my setup too", () => {
    const html = view({ readiness: null });
    expect((html.match(/<button[^>]*disabled=""[^>]*>Apply<\/button>/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check my setup<\/button>/);
  });
  test("a project on the general setting cannot be written, and says what to do", () => {
    const html = view({ root: "/work/orbit", scope: "global" });
    expect(html).toContain("Set it for this project first, or pick All projects.");
    expect((html.match(/<button[^>]*disabled=""[^>]*>Apply<\/button>/g) ?? []).length).toBe(3);
  });
  test("the server's sentence for a refusal sits in the card", () => {
    const html = view({ notes: { quick: "policy.workerDefault: is wider than the ceiling; lower the default or raise the ceiling on purpose" } });
    expect(html.indexOf("is wider than the ceiling")).toBeGreaterThan(html.indexOf("Quick setup"));
    expect(html.indexOf("is wider than the ceiling")).toBeLessThan(html.indexOf("Applies to"));
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
    expect(row).toContain("Active for all projects");
    expect(row).not.toMatch(/>Apply</);
    expect(rowOf(view({ policy: applied, readiness: ready }), "All workers on Claude Code")).toMatch(/>Apply</);
    expect(scopeWords("/home/me/code/orbit")).toBe("orbit");
  });
  test("the line under the card says what changed and where the rule is", () => {
    expect(appliedLine("Quick setup: x", true)).toContain('Added rule "Quick setup: x"');
    expect(appliedLine("Quick setup: x", false)).toContain("nothing changed");
    expect(quick).toContain("See it in Rules below");
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
  test("the page stores the choice in a guard and opens on it", () => {
    expect(PANE).toMatch(/try \{ return localStorage\.getItem\(SCOPE_KEY\)[\s\S]*?catch/);
    expect(PANE).toMatch(/try \{ localStorage\.setItem\(SCOPE_KEY[\s\S]*?catch/);
    expect(PANE).toContain("useState(() => readScope() ?? \"\")");
    expect(PANE).toContain("onRoot={pick}");
    expect(PANE).toContain("if (!chosen.current) setRoot(openingScope(");
  });
  test("a project with its own setting has a dot and says so in its title", () => {
    const html = view({ projects: ["/w/orbit", "/w/acme"], overrides: ["/w/orbit"] });
    expect(html).toContain(`/w/orbit — ${OWN_SETTING}`);
    expect(html).not.toContain(`/w/acme — ${OWN_SETTING}`);
  });
});

describe("an opened editor is brought to the eye", () => {
  const PANE = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
  test("opening a new rule scrolls its row into view, focuses its first field, and honours reduced motion", () => {
    const at = PANE.indexOf("function revealEditor(");
    const body = PANE.slice(at, PANE.indexOf("\n}\n", at));
    expect(body).toContain("scrollIntoView(");
    expect(body).toContain("prefers-reduced-motion: reduce");
    expect(body).toContain(".focus(");
    expect(PANE).toContain('if (editing === "new") revealEditor("new-rule")');
    expect(PANE).toContain('label="New rule"');
  });
  test("both buttons that open it set the same state the effect watches", () => {
    expect(PANE).toContain('setEditing("new"); }}>Add a fallback rule');
    expect(PANE).toContain('"new"); }}>Add a rule') ;
  });
});
