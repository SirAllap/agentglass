/*
 * The repository's tracker choice as the screens read it, and where it is
 * wired in.
 *
 * What a mistake costs: a ClickUp-only machine that starts asking for a choice
 * it can never have made, a failed read kept for a minute so the chip is wrong
 * until then, or a Settings row for a decision there is nothing to decide.
 * Requests are counted at `fetch`; the wiring is asserted against source,
 * because there is no renderer in this project.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

let mod: typeof import("../src/lib/trackerView.ts");
let calls: string[] = [];
let answer: () => Response = () => Response.json({ ok: true, projects: {} });

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  stubGlobal("fetch", async (url: string) => {
    calls.push(new URL(url).pathname);
    return answer();
  });
  mod = await import("../src/lib/trackerView.ts");
});

beforeEach(() => {
  calls = [];
  answer = () => Response.json({ ok: true, projects: {} });
  mod.__forgetTrackerChoices();
});

describe("trackerChoices", () => {
  test("reads once a minute, however many screens ask", async () => {
    answer = () => Response.json({ ok: true, projects: { "acme/orbit": "jira" } });
    const [a, b] = await Promise.all([mod.trackerChoices(), mod.trackerChoices()]);
    expect(a).toEqual({ "acme/orbit": "jira" });
    expect(b).toEqual(a);
    await mod.trackerChoices();
    expect(calls).toEqual(["/tracker/projects"]);
  });

  test("a failed read is auto everywhere and is not kept", async () => {
    answer = () => { throw new TypeError("no network"); };
    expect(await mod.trackerChoices()).toEqual({});
    answer = () => Response.json({ ok: true, projects: { "acme/orbit": "clickup" } });
    expect(await mod.trackerChoices()).toEqual({ "acme/orbit": "clickup" });
    // the client retries a dropped request itself; what matters is the second ask went out
    expect(calls.length).toBeGreaterThan(1);
  });

  test("an answer that says not ok is not kept either", async () => {
    answer = () => Response.json({ ok: false });
    expect(await mod.trackerChoices()).toEqual({});
    answer = () => Response.json({ ok: true, projects: { "acme/orbit": "jira" } });
    expect(await mod.trackerChoices()).toEqual({ "acme/orbit": "jira" });
  });

  test("a save in Settings is what the next screen reads, with no request", async () => {
    mod.rememberTrackerChoices({ "acme/orbit": "jira" });
    expect(await mod.trackerChoices()).toEqual({ "acme/orbit": "jira" });
    expect(calls).toEqual([]);
  });
});

describe("the view is null until Jira is connected", () => {
  const src = readFileSync(new URL("../src/lib/trackerView.ts", import.meta.url), "utf8");

  test("the choice is not even asked for on a machine without Jira", () => {
    expect(src).toContain("if (!hasJira) return;");
    // a "no" is stored as null, so a machine without Jira never redraws for the answer
    expect(src).toContain("setSetup(v.jira ? v : null)");
    expect(src).toContain("setup && all ? { setup, choice: choiceFor(all, repo) } : null");
  });

  test("an owner is only attached from a view, and the setup is otherwise itself", () => {
    const setup = { connected: true, prefix: "ORBIT-" };
    expect(mod.ownerSetup(setup, null)).toBe(setup);
  });
});

describe("where it is wired", () => {
  const pr = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

  test("the readers keep their calls; the setup they are handed is what changed", () => {
    // These literals are what the older card tests pin; ownership rides on the setup, not on new arguments.
    expect(pr).toContain("const ref = useMemo(() => mergeCardRefOrRow(d, setup), [d.headRefName, d.title, d.body, d.card, setup]);");
    expect(pr).toContain("const go = chipAction(ref, setup);");
    expect(term).toContain("chipAction(ref, cuSetup)");
  });

  test("every place that reads a card id takes its setup through useOwnerSetup", () => {
    expect(pr.match(/useOwnerSetup\(useClickupSetup\(\)/g)!.length).toBe(5);
    expect(pr).toContain("const clickup = useOwnerSetup(useClickupSetup(), repo?.nameWithOwner);");
    expect(term).toContain("const setup = useOwnerSetup(useClickupSetup());");
    expect(term).toContain("const cuSetup = useOwnerSetup(useClickupSetup());");
  });

  test("a Jira card is not looked up in ClickUp for its colour", () => {
    // The card is asked for only when ClickUp owns it: Jira's is never looked up there.
    expect(term).toContain('const gated = !!ref && !!setup?.connected && !(setup.ownerOf && setup.ownerOf(ref, true).owner !== "clickup");');
  });

  test("Settings draws the choice only when both trackers are connected", () => {
    expect(settings).toContain("const both = !!setup?.clickup && !!setup?.jira;");
    expect(settings).toContain("{both ? (<>");
    // and the request for the repositories is inside the same gate
    expect(settings).toMatch(/if \(!both\) return;\n\s+let live = true;\n\s+void api\.trackerProjects\(true\)/);
  });
});
