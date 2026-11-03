/*
 * Who sees the first run.
 *
 * The stored answer wins in both directions; the machine's facts answer only
 * while nothing was stored, which is what keeps an upgrade (a project open
 * since before this existed) out of a wizard. A read that failed hides it.
 */
import { describe, expect, it } from "bun:test";
import { factsOf, showSetup, type SetupFacts } from "../src/lib/setupGate.ts";
import type { SetupState } from "../../shared/types.ts";

const base: SetupFacts = {
  setupDone: null,
  setupInProgress: false,
  projectOpen: false,
  sessionsSeen: false,
  hooksInstalled: false,
  pickerAnswered: false,
};

const ALL_TRUE = { projectOpen: true, sessionsSeen: true, hooksInstalled: true, pickerAnswered: true };

describe("showSetup", () => {
  it("a stored false shows the wizard although every fact says this machine is set up", () => {
    expect(showSetup({ ...base, ...ALL_TRUE, setupDone: false })).toBe(true);
  });

  it("a stored true hides it although every fact says nothing was ever done", () => {
    expect(showSetup({ ...base, setupDone: true })).toBe(false);
  });

  it("never written, and any one fact true, hides it", () => {
    for (const key of Object.keys(ALL_TRUE) as (keyof typeof ALL_TRUE)[]) {
      expect(showSetup({ ...base, [key]: true })).toBe(false);
    }
  });

  it("never written and nothing true shows it", () => {
    expect(showSetup(base)).toBe(true);
  });

  it("a read that failed hides it: a hiccup never puts an existing user in a first run", () => {
    expect(showSetup(null)).toBe(false);
  });

  it("a run left open keeps it up over a project, which step 4 adds without ending the wizard", () => {
    expect(showSetup({ ...base, setupInProgress: true, projectOpen: true })).toBe(true);
  });

  it("a stored true still wins over a left-open run", () => {
    expect(showSetup({ ...base, setupDone: true, setupInProgress: true })).toBe(false);
  });
});

describe("factsOf", () => {
  it("reads the server's answer with the browser's own key", () => {
    const state = {
      setupDone: null, setupInProgress: true, setupAgent: "opencode", tutorialSeen: "",
      projectOpen: true, sessionsSeen: false, hooksInstalled: true, homedir: "/home/acme",
    } satisfies SetupState;
    expect(factsOf(state, true)).toEqual({
      setupDone: null, setupInProgress: true, projectOpen: true,
      sessionsSeen: false, hooksInstalled: true, pickerAnswered: true,
    });
  });
});
