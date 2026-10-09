/*
 * The approval screen says what a scope is.
 *
 * A plugin's scope limits the token it is handed, not the process: the
 * entrypoint is a command this user runs, with this user's files. "Cannot
 * write anything" beside a plugin that can was the consent gate telling the
 * one lie it exists to prevent. The warning is asserted against the source
 * because there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import { boxWording, processIsBoxed, processWillNotStart } from "../src/lib/pluginBoxState.ts";

const SRC = await Bun.file(new URL("../src/components/plugins/PluginDeclaration.tsx", import.meta.url)).text();
const BOX_SRC = await Bun.file(new URL("../src/lib/pluginBoxState.ts", import.meta.url)).text();
const DOC = (await Bun.file(new URL("../../docs/PLUGINS.md", import.meta.url)).text()).replace(/\s+/g, " ");

describe("approval screen", () => {
  test("carries the process warning, whatever the scope", () => {
    expect(SRC).toContain("PROCESS_WARNING");
    expect(SRC).toMatch(/runs as you/i);
    expect(SRC).toMatch(/limits its access to this app, not to your machine/i);
  });

  test("the warning is drawn in the component, not only defined — shown for an unboxed plugin, never a boxed one", () => {
    const i = SRC.indexOf("export function PluginDeclaration(");
    expect(i).toBeGreaterThan(0);
    expect(SRC.slice(i)).toContain("PROCESS_WARNING");
    expect(SRC.slice(i)).toMatch(/boxed \? BOXED_PROCESS_NOTE : [^\n]*: PROCESS_WARNING/);
    expect(SRC.slice(i)).toContain("processIsBoxed(box)");
  });

  test("a refused start does not get 'runs as you' either: its process note says it does not start", () => {
    const base = { sandbox: { network: "agentglass" as const, read: [], write: [], programs: [] }, running: false, boxState: undefined, lastBoxFailure: undefined };
    const refused = boxWording({ ...base, boxPlan: "refuse", sandboxProbe: { ok: false, reason: "missing", detail: "bwrap is not on PATH" } });
    expect(processWillNotStart(refused)).toBe(true);
    const consented = boxWording({ ...base, boxPlan: "unboxed-consented", sandboxProbe: { ok: false, reason: "missing", detail: "bwrap is not on PATH" } });
    expect(processWillNotStart(consented)).toBe(false);
    expect(SRC).toMatch(/processWillNotStart\(box\) \? REFUSED_PROCESS_NOTE/);
    expect(SRC.slice(SRC.indexOf("const REFUSED_PROCESS_NOTE"))).toMatch(/^const REFUSED_PROCESS_NOTE = "This plugin does not start/);
  });

  test("the process block agrees with the box block in every state: a box promised or built is never followed by 'runs as you'", () => {
    const base = { sandbox: { network: "agentglass" as const, read: [], write: [], programs: [] }, running: false, boxState: undefined, sandboxProbe: undefined, boxPlan: undefined, lastBoxFailure: undefined };
    // Before the plugin is switched on: the box card says "will run in a box".
    expect(boxWording(base)!.tone).toBe("neutral");
    expect(processIsBoxed(boxWording(base))).toBe(true);
    expect(processIsBoxed(boxWording({ ...base, sandboxProbe: { ok: true } }))).toBe(true);
    expect(processIsBoxed(boxWording({ ...base, running: true, boxState: { kind: "boxed" } }))).toBe(true);
    // No box block at all, or a box known to be missing: the warning stays.
    expect(processIsBoxed(boxWording({ ...base, sandbox: undefined }))).toBe(false);
    expect(processIsBoxed(boxWording({ ...base, boxPlan: "refuse", sandboxProbe: { ok: false, reason: "missing", detail: "bwrap is not on PATH" } }))).toBe(false);
    expect(processIsBoxed(boxWording({ ...base, running: true, boxState: { kind: "unboxed", reason: "failed", detail: "x" } }))).toBe(false);
  });

  test("no scope sentence claims the plugin cannot write or touch the machine", () => {
    const sentences = SRC.slice(SRC.indexOf("const SCOPE_SENTENCE"), SRC.indexOf("const SCOPE_WORD"));
    expect(sentences).not.toMatch(/cannot[^.]*write anything/i);
    expect(sentences).not.toMatch(/touch this machine/i);
  });
});

describe("approval screen, sandbox grants", () => {
  const body = SRC.slice(SRC.indexOf("export function PluginDeclaration("));

  test("draws the block from the shared description, and only when the plugin declared one", () => {
    expect(SRC).toContain("describeSandbox(");
    expect(body).toMatch(/plugin\.sandbox\s*\?\s*describeSandbox|d\s*&&/);
  });

  test("lists every read, write and program, and the network", () => {
    expect(body).toContain("d.reads");
    expect(body).toContain("d.writes");
    expect(body).toContain("d.programs");
    expect(body).toContain("d.internet");
  });

  test("marks a secret-looking path in the error colour", () => {
    expect(body).toMatch(/g\.secret[^\n]*var\(--error\)|var\(--error\)[^\n]*g\.secret/);
  });

  test("draws its box wording from the shared, testable helper, and that helper actually warns when the host cannot build one", () => {
    expect(SRC).toContain("boxWording(plugin)");
    expect(BOX_SRC).toMatch(/userns-blocked/);
    expect(BOX_SRC).toMatch(/bubblewrap is not installed/i);
    expect(BOX_SRC).toMatch(/box failed to start/i);
  });
});

describe("docs/PLUGINS.md", () => {
  test("says a plugin runs as the user unless a box is built, and scope limits only the token", () => {
    expect(DOC).toMatch(/runs as you/i);
    expect(DOC).toMatch(/scope limits the token, not the process/i);
  });

  test("documents the sandbox block as enforced when the host can build a box, unboxed with a warning otherwise", () => {
    expect(DOC).toMatch(/`sandbox` \|[^|]*Enforced when this host can build a `bwrap` box/);
    expect(DOC).toMatch(/AppArmor user-namespace limit/);
  });

  test("no longer promises a read plugin cannot write", () => {
    expect(DOC).not.toMatch(/Cannot write anything/);
  });
});

describe("comments about the sandbox block say what docs/PLUGINS.md says", () => {
  test("neither the manifest type nor the public plugin type calls the box unenforced", async () => {
    const sandbox = await Bun.file(new URL("../../shared/pluginSandbox.ts", import.meta.url)).text();
    const types = await Bun.file(new URL("../../shared/types.ts", import.meta.url)).text();
    expect(DOC).toMatch(/Enforced when this host can build a `bwrap` box/);
    expect(sandbox).not.toMatch(/Nothing enforces it yet/i);
    expect(types).not.toMatch(/Declared, not yet enforced/i);
    expect(sandbox).toMatch(/refused on Linux until it is allowed to run unboxed/);
  });
});
