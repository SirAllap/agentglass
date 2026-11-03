/*
 * Presets on the global page, drawn from what they are handed: the cards, the
 * parts toggles and the file preview, and an import that shows a file before
 * anything is usable. The policy and the flow are pure functions
 * (shared/preset.ts), so this file reads the screen and the two sentences a
 * refusal carries, not a renderer's events.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { PRESET_PARTS, presetOf, presetPolicyParts, presetSaveParts, presetText, withoutParts, type PresetFile, type PresetTarget } from "../../shared/preset.ts";
import { PresetCards, type PresetCardsProps } from "../src/components/orchestration/PresetCards.tsx";

const policy = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const target = (): PresetTarget => ({ policy: policy(), flow: templateFlow() });
const preset = (name: string, over: Partial<PresetFile> = {}): PresetFile => ({ ...presetOf(target(), name), ...over });
const shipped = preset("Careful");
const own = preset("Night shift");

const cards = (o: Partial<PresetCardsProps> = {}) => renderToStaticMarkup(React.createElement(PresetCards, {
  target: target(), projectRoot: "/work/orbit", shipped: [shipped], mine: [own], onApply: async () => null, ...o,
} as PresetCardsProps));

/** The component's own source, for the two decisions a static render cannot press. */
const src = await Bun.file(new URL("../src/components/orchestration/PresetCards.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const buttonAt = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</button>`);
  expect(at, label).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", html.lastIndexOf("<button", at)) + 1);
};

/** One parts toggle, from the tag that carries it. */
const toggleAt = (html: string, part: string): string => {
  const at = html.indexOf(`data-toggle="${part}"`);
  expect(at, part).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
};

describe("the cards", () => {
  test("the shipped setups and the person's own are listed, and each says where it came from", () => {
    const html = cards();
    expect(html).toContain('data-preset="Careful"');
    expect(html).toContain('data-preset="Night shift"');
    expect(html).toContain(">Shipped<");
    expect(html).toContain(">Yours<");
    expect(html).toContain('data-yours=""');
  });

  test("a person's preset that shares a shipped name is the one card, so a name picks one setup", () => {
    const html = cards({ shipped: [preset("Careful")], mine: [preset("Careful")] });
    expect((html.match(/data-preset="Careful"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-yours=""');
  });

  test("a preset shows which parts it sets, and a rule in it is one sentence a person reads", () => {
    const html = cards({ openPreset: "Careful" });
    for (const part of PRESET_PARTS) expect(html).toContain(`data-part="${part}"`);
    expect(html).toContain("Rules that move roles");
    expect(html).toContain("Use this preset");
  });

  test("with no presets it says what to do, and invents none", () => {
    const html = cards({ shipped: [], mine: [] });
    expect(html).toContain("No preset here yet");
    expect(html).not.toContain("data-preset=");
  });
});

describe("sharing one", () => {
  test("the parts are toggles, and what is switched off is not in the file", () => {
    const html = cards({ open: "share", openPreset: "Night shift" });
    for (const part of PRESET_PARTS) expect(html).toContain(`data-toggle="${part}"`);
    expect(html).toContain(presetText(own, own.includes).slice(0, 40).replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
    const withoutPrompts = presetText(own, own.includes.filter((p) => p !== "prompts"));
    expect(withoutPrompts).not.toBe(presetText(own));
    expect(withoutParts(own, ["flow", "look"]).policy).toBeUndefined();
  });

  test("the file it downloads is the text it previews", () => {
    const html = cards({ open: "share", openPreset: "Night shift" });
    expect(html).toContain("Download .agxpreset");
    expect(html).toContain("Copy as text");
    expect(html).toContain("data-file");
    // The same JSON the download writes is in the panel, so the preview is not a drawing of the file.
    expect(html).toContain("agentglass-preset");
  });

  test("a part the preset does not carry is not on offer, so no tick writes a file the importer refuses", () => {
    // A shipped setup carries the rules only: the flow it has not got cannot be switched on.
    const rulesOnly = { ...preset("Careful"), includes: ["rules"] as PresetFile["includes"], flow: undefined };
    const html = cards({ shipped: [rulesOnly], open: "share", openPreset: "Careful" });
    expect(toggleAt(html, "flow")).toContain("disabled");
    expect(toggleAt(html, "team")).toContain("disabled");
    expect(toggleAt(html, "rules")).not.toContain("disabled");
  });
});

describe("importing one", () => {
  const good = presetText(preset("From a friend"));

  test("a pasted file is shown before it is usable, and Use is offered", () => {
    const html = cards({ open: "import", importText: good });
    expect(html).toContain("data-import-preview");
    expect(html).toContain("From a friend");
    expect(buttonAt(html, "Use this preset")).not.toMatch(/ disabled[ =>]/);
  });

  test("a refused file prints the refusal and Use stays disabled", () => {
    const bad = JSON.stringify({ format: "agentglass-preset", version: 1, name: "Nope", includes: ["nope"] });
    const html = cards({ open: "import", importText: bad });
    expect(html).toContain('role="alert"');
    expect(html).toContain("is not a part of a setup");
    expect(html).not.toContain("data-import-preview");
    expect(buttonAt(html, "Use this preset")).toMatch(/ disabled[ =>]/);
  });

  test("text that is not JSON is refused in words a person reads", () => {
    const html = cards({ open: "import", importText: "hello" });
    expect(html).toContain("it is not JSON");
    expect(buttonAt(html, "Use this preset")).toMatch(/ disabled[ =>]/);
  });

  test("a file can be dropped or chosen, and it lands in the same box a paste does", () => {
    const html = cards({ open: "import" });
    expect(html).toContain("data-drop");
    expect(html).toContain("data-file-input");
    expect(html).toContain('accept=".agxpreset,application/json"');
  });
});

describe("All projects", () => {
  test("a flow part under All projects is refused with the way out offered", () => {
    const html = cards({ projectRoot: "", openPreset: "Night shift" });
    expect(html).toContain("A flow belongs to one project");
    expect(html).toContain("Apply the policy parts only");
    expect(html).toContain("data-flow-refused");
    // The card's own Use cannot apply a flow part here either; the sentence beside it is the way out.
    expect(buttonAt(html, "Use this preset")).toMatch(/ disabled[ =>]/);
  });

  test("the import panel offers the same way out, and does not leave Use as a dead end", () => {
    const html = cards({ projectRoot: "", open: "import", importText: presetText(preset("From a friend")) });
    expect(html).toContain("data-import-flow");
    expect(html.indexOf("data-import-flow")).toBeGreaterThan(html.indexOf('data-panel="import"'));
    expect(html.slice(html.indexOf("data-import-flow"))).toContain("Apply the policy parts only");
    // The primary button cannot apply a flow part here; the way out above it is the action.
    expect(buttonAt(html, "Use this preset")).toMatch(/ disabled[ =>]/);
  });

  test("a file with the policy parts only is used straight away", () => {
    const html = cards({ projectRoot: "", open: "import", importText: presetText(preset("Policy only"), presetPolicyParts(PRESET_PARTS)) });
    expect(html).not.toContain("data-import-flow");
    expect(buttonAt(html, "Use this preset")).not.toMatch(/ disabled[ =>]/);
  });

  test("Save mine says the flow stays out, so a machine-wide preset holds no roster", () => {
    const html = cards({ projectRoot: "", open: "new" });
    expect(html).toContain("A flow belongs to one project");
    // The panel's own save passes the parts All projects can carry, not every part of the setup on screen.
    expect(code(src)).toContain("presetSaveParts(flowHome)");
    expect(presetSaveParts(false)).not.toContain("flow");
  });
});

describe("the download", () => {
  test("keeps the blob URL alive past the click, so Firefox does not cancel the file", () => {
    const body = code(src).slice(code(src).indexOf("const download = ("));
    const fn = body.slice(0, body.indexOf("\n  };"));
    expect(fn).toContain("a.click();");
    // Nothing revokes the URL that was just clicked; the one before it is released when the next file is made.
    expect(fn).not.toContain("URL.revokeObjectURL(href)");
    expect(fn.indexOf("URL.revokeObjectURL(lastSavedUrl)")).toBeGreaterThan(-1);
    expect(fn.indexOf("URL.revokeObjectURL(lastSavedUrl)")).toBeLessThan(fn.indexOf("URL.createObjectURL(blob)"));
    expect(code(src)).toContain("document.body.appendChild(a);");
  });
});
