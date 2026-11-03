/*
 * The `.agxpreset` file: one closed validator and one pure apply, held without a
 * server or a renderer. A file round-trips through its own text, an unknown key
 * or part is refused by name, a pasted key cannot get in, and a setup can never
 * hand out more safety than the project already allows.
 */
import { describe, expect, test } from "bun:test";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { validateFlow } from "../../shared/flow.ts";
import {
  PRESET_FORMAT, PRESET_NEVER_INCLUDED, PRESET_PARTS, PRESET_VERSION, applyPreset, parsePresetText, presetFileName, presetNameTaken,
  presetOf, presetPolicyParts, presetSaveParts, presetText, presetWritableParts, validatePreset, validatePresetList, withoutParts, type PresetFile, type PresetTarget,
} from "../../shared/preset.ts";

const policy = (over: Partial<Policy> = {}): Policy => ({
  ...composePolicy(defaultStored(), {
    orchestrator: { engine: "claude", model: "sonnet" },
    workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
  }),
  ...over,
});
const target = (over: Partial<PresetTarget> = {}): PresetTarget => ({ policy: policy(), flow: templateFlow(), ...over });
const file = (over: Partial<PresetFile> = {}): PresetFile => ({ ...presetOf(target(), "Night shift"), ...over });
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r as { error: string }).error);

describe("a file round-trips", () => {
  test("what the page writes validates, and applying it to the same setup changes nothing", () => {
    const before = target();
    const written = presetText(presetOf(before, "Night shift"));
    const read = parsePresetText(written);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.name).toBe("Night shift");
    expect(read.value.includes).toEqual([...PRESET_PARTS]);
    const after = applyPreset(read.value, before);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.policy).toEqual(before.policy);
    expect(after.value.flow).toEqual(before.flow);
  });

  test("the template flow is a flow the preset can carry", () => {
    expect(validateFlow(JSON.parse(JSON.stringify(templateFlow()))).ok).toBe(true);
  });

  test("a file's name becomes a file name a person recognises", () => {
    expect(presetFileName("Night shift (mine)")).toBe("night-shift-mine.agxpreset");
    expect(presetFileName("")).toBe("preset.agxpreset");
  });
});

describe("a file is closed", () => {
  test("a wrong format or version is refused by name", () => {
    expect(errorOf(validatePreset({ ...file(), format: "agentglass" }))).toContain('format: has to be "agentglass-preset"');
    expect(errorOf(validatePreset({ ...file(), version: 2 }))).toContain("version: has to be 1");
    expect(PRESET_FORMAT).toBe("agentglass-preset");
    expect(PRESET_VERSION).toBe(1);
  });

  test("an unknown key anywhere is refused, never dropped", () => {
    expect(errorOf(validatePreset({ ...file(), extra: true }))).toContain("preset.extra: is not a setting");
    expect(errorOf(validatePreset({ ...file(), policy: { ...file().policy, nope: 1 } }))).toContain("policy.nope: is not a setting");
    expect(errorOf(validatePreset({ ...file(), includes: ["flow"], flow: { ...templateFlow(), extra: 1 } }))).toContain("flow.extra: is not a setting");
  });

  test("a string shaped like a key is refused wherever it sits", () => {
    expect(errorOf(validatePreset({ ...file(), name: "sk-live-abcdef" }))).toContain("looks like a key");
    const policyWithKey = { ...file().policy, base: { orchestrator: [{ engine: "claude", model: "ghp_abcdefghijklmnop" }] } };
    expect(errorOf(validatePreset({ ...file(), policy: policyWithKey }))).toContain("looks like a key");
  });

  test("an unknown part id is refused by name, and so is the mockup's orchestrator notes", () => {
    expect(errorOf(validatePreset({ ...file(), includes: ["flow", "nope"] }))).toContain('"nope" is not a part of a setup');
    expect(errorOf(validatePreset({ ...file(), includes: ["flow", "orch"] }))).toContain("no setting here");
  });

  test("a file that says it carries prompts and has none is refused", () => {
    const flow = templateFlow();
    const stripped = { ...flow, roster: flow.roster.map(({ prompt: _p, ...r }) => r) };
    const r = validatePreset({ ...file(), includes: ["prompts"], flow: stripped });
    expect(errorOf(r)).toContain("is missing, and includes prompts");
  });

  test("a file that says it carries names and icons, and left one out, is refused rather than renamed", () => {
    const flow = templateFlow();
    for (const field of ["name", "does", "ico", "hue"] as const) {
      const stripped = { ...flow, roster: flow.roster.map(({ [field]: _gone, ...r }) => r) };
      const r = validatePreset({ ...file(), includes: ["flow", "look"], flow: stripped });
      expect(errorOf(r), field).toContain(`flow.roster[0].${field}: is missing, and includes look`);
    }
    // The same fields with the look part switched off are what a switched-off part leaves out, and fill in for the check.
    const stripped = { ...flow, roster: flow.roster.map(({ name: _n, does: _d, ico: _i, hue: _h, ...r }) => r) };
    expect(validatePreset({ ...file(), includes: ["flow"], flow: stripped }).ok).toBe(true);
  });

  test("a list of presets refuses a repeated name and a bad member", () => {
    const one = file();
    expect(validatePresetList([one, { ...one }]).ok).toBe(false);
    expect(validatePresetList([one]).ok).toBe(true);
    expect(errorOf(validatePresetList("nope"))).toContain("has to be a list");
  });

  test("the list of what is never inside a file is this build's, whatever the file says", () => {
    const r = validatePreset({ ...file(), neverIncluded: ["nothing"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.neverIncluded).toEqual([...PRESET_NEVER_INCLUDED]);
  });
});

describe("a part that was switched off", () => {
  test("is not written into the file, so a prompt cannot leave by accident", () => {
    const prompt = target().flow!.roster[0]!.prompt;
    const text = presetText(file(), ["flow", "look"]);
    expect(text).not.toContain(prompt);
    const read = parsePresetText(text);
    expect(read.ok).toBe(true);
  });

  test("cannot be applied later, even by a caller that asks for it", () => {
    const stripped = withoutParts(file(), ["flow", "look"]);
    const read = validatePreset(JSON.parse(JSON.stringify(stripped)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(errorOf(applyPreset(read.value, target(), ["prompts"]))).toContain("the file was shared without it");
  });

  test("an empty includes applies nothing at all", () => {
    const before = target();
    const r = applyPreset(file({ includes: [] }), before);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.policy).toEqual(before.policy);
      expect(r.value.flow).toEqual(before.flow);
    }
  });
});

describe("the share panel writes only what the importer takes", () => {
  test("a part the preset does not carry cannot be switched on in the file it writes", () => {
    // A shipped setup carries the rules and nothing else.
    const shipped = { ...file(), includes: ["rules"] as PresetFile["includes"] };
    expect(presetWritableParts(shipped, ["rules", "flow"])).toEqual(["rules"]);
    const read = parsePresetText(presetText(shipped, ["rules", "flow"]));
    expect(read.ok, errorOf(read)).toBe(true);
    if (read.ok) expect(read.value.includes).toEqual(["rules"]);
  });

  test("every combination the panel can offer is a file the importer takes back", () => {
    // The shapes a card can hold: one that carries everything, a shipped one that carries the rules, and one
    // whose names and prompts were switched off before it was saved.
    const shapes = [file(), { ...file(), includes: ["rules"] as PresetFile["includes"] }, withoutParts(file(), ["flow", "team", "fb"])];
    for (const preset of shapes) {
      const writable = presetWritableParts(preset);
      for (let mask = 0; mask < 1 << writable.length; mask++) {
        const asked = writable.filter((_, i) => (mask & (1 << i)) !== 0);
        expect(parsePresetText(presetText(preset, asked)).ok, `${preset.name}: ${asked.join(",")}`).toBe(true);
      }
    }
  });

  test("names switched off once cannot be switched back on, and the file still imports", () => {
    const shared = withoutParts(file(), ["flow", "team", "fb"]);
    const read = validatePreset(JSON.parse(JSON.stringify(shared)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(presetWritableParts(read.value, ["flow", "team", "fb", "look", "prompts"])).toEqual(["flow", "fb", "team"]);
    const again = parsePresetText(presetText(read.value, ["flow", "team", "fb", "look", "prompts"]));
    expect(again.ok, errorOf(again)).toBe(true);
  });

  test("switching the fallbacks and rounds off keeps a role of a person's own whole, so the file still imports", () => {
    const custom = templateFlow().roster.find((r) => r.id === "qa-only")!;
    const parts = PRESET_PARTS.filter((p) => p !== "fb");
    const read = parsePresetText(presetText(file(), parts));
    expect(read.ok, errorOf(read)).toBe(true);
    if (read.ok) expect(read.value.flow!.roster.find((r) => r.id === "qa-only")!.chain).toEqual(custom.chain);
  });

  test("the flow switched off leaves no path, places, arrows or stages in the file", () => {
    const text = presetText(file(), PRESET_PARTS.filter((p) => p !== "flow"));
    const written = JSON.parse(text) as { flow?: Record<string, unknown> };
    expect(written.flow).toBeDefined();
    for (const key of ["path", "blocks", "edges", "stages"]) expect(written.flow![key], key).toBeUndefined();
    const read = parsePresetText(text);
    expect(read.ok, errorOf(read)).toBe(true);
    if (!read.ok) return;
    const before = target();
    const after = applyPreset(read.value, before);
    expect(after.ok, errorOf(after)).toBe(true);
    if (after.ok) expect(after.value.flow).toEqual(before.flow);
  });

  test("the fallbacks and rounds switched off leave an arrow with no cap in the file", () => {
    const text = presetText(file(), PRESET_PARTS.filter((p) => p !== "fb"));
    const written = JSON.parse(text) as { flow: { edges: { on: string; maxRounds?: number }[] } };
    expect(written.flow.edges.some((e) => e.on === "fail")).toBe(true);
    expect(written.flow.edges.every((e) => e.maxRounds === undefined)).toBe(true);
    const read = parsePresetText(text);
    expect(read.ok, errorOf(read)).toBe(true);
    if (!read.ok) return;
    const before = target();
    const after = applyPreset(read.value, before);
    expect(after.ok, errorOf(after)).toBe(true);
    if (after.ok) expect(after.value.flow).toEqual(before.flow);
  });

  test("the engines switched off leave no chain on a role, a role of a person's own included", () => {
    const text = presetText(file(), PRESET_PARTS.filter((p) => p !== "eng"));
    const written = JSON.parse(text) as { flow: { roster: { id: string; chain?: unknown }[] }; policy?: { base?: unknown } };
    expect(written.flow.roster.some((r) => r.id === "qa-only")).toBe(true);
    expect(written.flow.roster.every((r) => r.chain === undefined)).toBe(true);
    expect(written.policy?.base).toBeUndefined();
    const read = parsePresetText(text);
    expect(read.ok, errorOf(read)).toBe(true);
    if (!read.ok) return;
    const before = target();
    const after = applyPreset(read.value, before);
    expect(after.ok, errorOf(after)).toBe(true);
    if (after.ok) expect(after.value.flow).toEqual(before.flow);
  });
});

describe("a role the project does not have", () => {
  test("is refused rather than stored with the placeholder the validator filled in", () => {
    const before = target();
    const fewer: PresetTarget = { policy: before.policy, flow: { ...before.flow!, roster: before.flow!.roster.filter((r) => r.id !== "qa-only") } };
    const shared = withoutParts(file(), ["flow", "team", "fb"]);
    const read = validatePreset(JSON.parse(JSON.stringify(shared)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const r = applyPreset(read.value, fewer);
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("is a role this project does not have");
    expect(errorOf(r)).toContain("without names");
  });

  test("arrives with its own name and prompt when the project already has that role", () => {
    const before = target();
    const mine = before.flow!.roster.find((r) => r.id === "qa-only")!;
    const read = validatePreset(JSON.parse(JSON.stringify(withoutParts(file(), ["flow", "team", "fb"]))));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const r = applyPreset(read.value, before);
    expect(r.ok, errorOf(r)).toBe(true);
    if (r.ok) {
      const kept = r.value.flow!.roster.find((x) => x.id === "qa-only")!;
      expect(kept.name).toBe(mine.name);
      expect(kept.prompt).toBe(mine.prompt);
    }
  });
});

describe("safety always wins", () => {
  const safety = (ceiling: Policy["ceiling"], workerDefault: Policy["workerDefault"]) => ({ ...file(), includes: ["safety"] as PresetFile["includes"], policy: { ceiling, workerDefault } });

  test("a file asking for the network when the project's ceiling has it off is refused, not applied", () => {
    const before = target();
    const asked = safety({ ...before.policy.ceiling, network: true }, { ...before.policy.workerDefault, network: true });
    const r = applyPreset(asked, before);
    expect(errorOf(r)).toContain("asks for more than this project's most the main agent may allow");
  });

  test("a write wider than the ceiling in force is refused too", () => {
    const before = target({ policy: { ...policy(), ceiling: { ...policy().ceiling, write: "none" }, workerDefault: { ...policy().workerDefault, write: "none" } } });
    const asked = safety({ ...before.policy.ceiling, write: "worktree" }, { ...before.policy.workerDefault, write: "none" });
    expect(errorOf(applyPreset(asked, before))).toContain("asks for more than this project's most the main agent may allow");
  });

  test("a safety part inside the ceiling applies, and the extra refusals only ever add", () => {
    const before = target();
    const asked = { ...file(), includes: ["safety", "refused"] as PresetFile["includes"], policy: { ceiling: before.policy.ceiling, workerDefault: before.policy.workerDefault }, alsoRefusedHere: ["npm publish"] };
    const r = applyPreset(asked, before);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.workerDefault.deny).toEqual(["npm publish"]);
  });

  test("a safety part never empties the refusals the project already has", () => {
    const base = policy();
    const before = target({ policy: { ...base, workerDefault: { ...base.workerDefault, deny: ["rm -rf"] } } });
    const asked = { ...file(), includes: ["safety"] as PresetFile["includes"], policy: { ceiling: before.policy.ceiling, workerDefault: { ...before.policy.workerDefault, deny: [] } } };
    const r = applyPreset(asked, before);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.workerDefault.deny).toEqual(["rm -rf"]);
  });

  test("a safety part with refusals of its own keeps the project's, and adds", () => {
    const base = policy();
    const before = target({ policy: { ...base, workerDefault: { ...base.workerDefault, deny: ["rm -rf"] } } });
    const asked = { ...file(), includes: ["safety"] as PresetFile["includes"], policy: { ceiling: before.policy.ceiling, workerDefault: { ...before.policy.workerDefault, deny: ["npm publish"] } } };
    const r = applyPreset(asked, before);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.workerDefault.deny).toEqual(["rm -rf", "npm publish"]);
  });

  test("a file cannot grant a push: the envelope has no field for one", () => {
    const envelope = { write: "worktree", network: false, commit: true, docker: false, deny: [] };
    const r = validatePreset({ ...file(), policy: { ...file().policy, ceiling: { ...envelope, push: true } } });
    expect(errorOf(r)).toContain("policy.ceiling.push: is not a setting");
  });
});

describe("the policy parts land where they belong", () => {
  test("a shipped rule replaces the rule with its id and leaves the rest alone", () => {
    const mine = { id: "night", name: "Night", enabled: true, when: [{ kind: "always" as const }], workers: { scout: [{ engine: "opencode", model: "" }] } };
    const before = target({ policy: policy({ rules: [mine] }) });
    const rule = { id: "preset-save-my-plan", name: "Save the plan", enabled: true, when: [{ kind: "always" as const }], workers: { builder: [{ engine: "opencode", model: "" }] } };
    const r = applyPreset({ ...file(), includes: ["rules"], policy: { rules: [rule] } }, before);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.rules.map((x) => x.id)).toEqual(["night", "preset-save-my-plan"]);
  });

  test("a flow part alone leaves the names, prompts and chains this project already has", () => {
    const before = target();
    const other = templateFlow();
    const renamed = { ...other, roster: other.roster.map((r, i) => (i === 0 ? { ...r, name: "Someone else", prompt: "Another prompt." } : r)) };
    const r = applyPreset({ ...file(), includes: ["flow"], flow: renamed }, before);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.flow!.roster[0]!.name).toBe(before.flow!.roster[0]!.name);
      expect(r.value.flow!.roster[0]!.prompt).toBe(before.flow!.roster[0]!.prompt);
    }
  });
});

describe("All projects, where a flow has no home", () => {
  test("what Save mine stores there carries no flow, so no project's roster is written machine-wide", () => {
    const parts = presetSaveParts(false);
    expect(parts).toEqual(presetPolicyParts(PRESET_PARTS));
    expect(parts).not.toContain("flow");
    const saved = presetOf(target(), "Every project", parts);
    expect(saved.flow).toBeUndefined();
    expect(saved.includes).toEqual(parts);
    // The same file under a project keeps the whole setup.
    expect(presetOf(target(), "One project", presetSaveParts(true)).flow).toBeDefined();
    const read = validatePreset(JSON.parse(JSON.stringify(saved)));
    expect(read.ok).toBe(true);
  });

  test("applying a flow part with no project above it is refused, and the policy parts still apply", () => {
    const none: PresetTarget = { policy: policy(), flow: null };
    expect(errorOf(applyPreset(file(), none))).toContain("a flow belongs to one project");
    const only = applyPreset(file(), none, presetPolicyParts(PRESET_PARTS));
    expect(only.ok).toBe(true);
    if (only.ok) expect(only.value.flow).toBeNull();
  });

  test("a flow part saved with no flow part in the file is refused too", () => {
    const saved = presetOf(target(), "Every project", presetPolicyParts(PRESET_PARTS));
    expect(errorOf(applyPreset(saved, target(), ["flow"]))).toContain("the file was shared without it");
  });

  test("a person's preset may not take a shipped setup's name", () => {
    const shipped = [presetOf(target(), "Careful"), presetOf(target(), "All workers on Claude Code")];
    expect(presetNameTaken("Careful", shipped)).toBe(true);
    expect(presetNameTaken("Night shift", shipped)).toBe(false);
  });
});
