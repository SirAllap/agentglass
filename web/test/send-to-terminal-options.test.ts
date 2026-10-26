/*
 * "Hand to Claude" said Claude while the hand-off starts whichever engine the
 * person set as their default, and the "⋯" beside each prompt only offered
 * permission modes. The label is now "Send to terminal", and the "⋯" is one
 * component with three entries, used by the pull request menu and the card's
 * hand-off list. Source is asserted against source: there is no renderer here.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { modesFor, type HandoffEngines } from "../src/lib/handoffEngines.ts";
import { AGENT_PROVIDERS } from "../../shared/agentKinds.ts";

const REPO = new URL("../../", import.meta.url).pathname;

/** Comments flattened too: a phrase wrapped across two comment lines is one phrase to a reader. */
const flat = (src: string) => src.replace(/\s*\n\s*(\*|\/\/)?\s*/g, " ");
const read = (p: string) => Bun.file(REPO + p).text();

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob("**/*.{ts,tsx}").scan({ cwd: REPO + dir })) {
    if (!f.includes("node_modules")) out.push(dir + "/" + f);
  }
  return out;
}

describe("Send to terminal", () => {
  it("no 'Hand to Claude' is left in web/ or mobile/", async () => {
    const files = [...(await sources("web/src")), ...(await sources("mobile/app")), ...(await sources("mobile/src"))];
    expect(files.length).toBeGreaterThan(100);
    const left: string[] = [];
    for (const f of files) if (/Hand to Claude/.test(flat(await read(f)))) left.push(f);
    expect(left).toEqual([]);
  });

  it("no label still names Claude for a hand-off that starts the default engine", async () => {
    const left: string[] = [];
    for (const f of await sources("web/src")) {
      const src = flat(await read(f));
      for (const phrase of ["Hand it to Claude", "Ask Claude", "Review with Claude", "Worktree + Claude"]) if (src.includes(phrase)) left.push(`${f}: ${phrase}`);
    }
    expect(left).toEqual([]);
  });

  it("the review button names the engine a click starts", async () => {
    const pr = await read("web/src/components/PrPanel.tsx");
    expect(pr).toContain("Review with {agentName(engines)}");
  });

  it("the ⋯ menu offers the three entries and opens no chat", async () => {
    const src = await read("web/src/components/PromptOptions.tsx");
    for (const entry of ["Run with…", "Permission mode for this run", "Edit prompt before sending"]) {
      expect(src).toContain(`>${entry}</MenuItem>`);
    }
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/chat/i);
  });

  it("both the pull request rows and the card's hand-off rows use it", async () => {
    expect(await read("web/src/components/PrPanel.tsx")).toMatch(/<PromptOptions label=\{r\.title\}/);
    const tasks = await read("web/src/components/TasksPanel.tsx");
    expect(tasks.match(/<PromptOptions /g)?.length).toBe(2);
  });

  it("the modes offered are the ones the engine has a flag for", async () => {
    const src = await read("web/src/lib/handoffEngines.ts");
    expect(src).toContain('if (kind === "claude") return [...LAUNCH_MODES]');
    expect(src).toContain("e.flags.overrides[kind]?.[m] ?? e.flags.builtin[kind]?.[m]");
  });

  it("lists only the modes the engine really maps: OpenCode bypass, Codex auto and bypass", () => {
    // The shape GET /launch-flags answers: the engine table's own words, no overrides.
    const e: HandoffEngines = { def: "opencode", engines: [], flags: { overrides: {}, builtin: Object.fromEntries(AGENT_PROVIDERS.map((k) => [k.id, k.modeFlags ?? {}])) as never } };
    expect(modesFor(e, "opencode")).toEqual(["bypassPermissions"]);
    expect(modesFor(e, "codex")).toEqual(["auto", "bypassPermissions"]);
    expect(modesFor(e, "claude")).toEqual(["default", "auto", "acceptEdits", "bypassPermissions"]);
    // A mode the person typed flags for appears; an emptied one goes.
    const own: HandoffEngines = { ...e, flags: { ...e.flags, overrides: { opencode: { acceptEdits: ["--edits"], bypassPermissions: [] } } } };
    expect(modesFor(own, "opencode")).toEqual(["acceptEdits"]);
  });

  it("the mode list opens with My setting, then the engine's modes", async () => {
    const src = await read("web/src/components/PromptOptions.tsx");
    expect(src.indexOf("send({})}>My setting")).toBeGreaterThan(0);
    expect(src.indexOf("send({})}>My setting")).toBeLessThan(src.indexOf("modes.map("));
  });
});
