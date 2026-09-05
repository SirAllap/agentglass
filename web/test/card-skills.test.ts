import { describe, expect, it } from "bun:test";
import { cardSkills, skillCommand, windowName, skillModes } from "../../shared/cardSkills.ts";
import type { SkillInfo } from "../../shared/types.ts";

const mk = (name: string, description = ""): SkillInfo => ({
  name, description, kind: "skill", argument_hint: null, source: "user",
  copies: 1, path: `/skills/${name}`, added: 0, runs: 0,
} as unknown as SkillInfo);

describe("which skills take a card", () => {
  it("finds the ones named for it", () => {
    const got = cardSkills([mk("clickup-card-fix"), mk("deploy"), mk("clickup-time-log")]).map((s) => s.name);
    expect(got).toEqual(["clickup-card-fix", "clickup-time-log"]);
  });

  it("finds the ones that only SAY they take a card", () => {
    // The two worth catching: neither is named for ClickUp, both take a card,
    // and both are the ones you would never think to look for.
    const got = cardSkills([
      mk("csp-sentry-sweep", "On-demand triage of the report-only violation stream in ClickUp"),
      mk("slack-cu-diff", "Compare a project's channel against its specs"),
      mk("write-tests", "Write tests for the current diff"),
    ]).map((s) => s.name);
    expect(got).toContain("csp-sentry-sweep");
    expect(got).toContain("slack-cu-diff");
    expect(got).not.toContain("write-tests");
  });

  it("puts the ones named for it first, then holds a stable order", () => {
    const got = cardSkills([
      mk("zeta-report", "reads a ClickUp card"),
      mk("clickup-management"),
      mk("alpha-report", "also reads a ClickUp card"),
    ]).map((s) => s.name);
    expect(got[0]).toBe("clickup-management");
    expect(got.slice(1)).toEqual(["alpha-report", "zeta-report"]);
  });

  it("does not drag in everything with the letters cu in it", () => {
    const got = cardSkills([mk("document-api", "documents the api"), mk("accumulate", "accumulates")]);
    expect(got).toEqual([]);
  });
});

describe("the line handed to the agent", () => {
  it("uses the id a person would recognise, not the internal one", () => {
    // A skill asking for the human id and given the internal one fails in the
    // least useful way available: the card exists, the tool cannot find it.
    expect(skillCommand("clickup-card-fix", { id: "86xabc001", customId: "ABC-1234" }))
      .toBe("/clickup-card-fix ABC-1234");
  });

  it("falls back to the internal id when the workspace has no custom ones", () => {
    expect(skillCommand("clickup-card-fix", { id: "86xabc001" })).toBe("/clickup-card-fix 86xabc001");
  });

  it("does not double the slash a skill name may already carry", () => {
    expect(skillCommand("/clickup-card-fix", { id: "x" })).toBe("/clickup-card-fix x");
  });
});

describe("the tmux window it opens", () => {
  it("is named after the card, so `tmux ls` is readable", () => {
    expect(windowName({ id: "86xabc001", customId: "ABC-1234" })).toBe("abc-1234");
  });

  it("strips what tmux would read as a target separator", () => {
    // A window whose name contains a dot cannot be selected by name later:
    // tmux reads it as session.window.
    expect(windowName({ id: "a.b:c", customId: "X.Y-1" })).toBe("xy-1");
  });

  it("always produces something", () => {
    expect(windowName({ id: "!!!" })).toBe("card");
  });
});

describe("the modes a skill advertises", () => {
  it("reads them from the invocation line the skill publishes", () => {
    // The skill itself says it has gears. Keeping our own list of them would be
    // wrong the day one grows a third, and wrong silently.
    expect(skillModes("[CARD-ID or URL] [autonomous | yolo]")).toEqual(["autonomous", "yolo"]);
  });

  it("ignores a slot, which is not a choice", () => {
    // `[CARD-ID or URL]` is where the card goes. The pipe is what makes a menu.
    expect(skillModes("[CARD-ID or URL]")).toEqual([]);
    expect(skillModes("<task id>")).toEqual([]);
  });

  it("has nothing to offer when the skill said nothing", () => {
    expect(skillModes(null)).toEqual([]);
    expect(skillModes("")).toEqual([]);
  });

  it("keeps only single words, since that is what gets typed", () => {
    expect(skillModes("[quick | take your time]")).toEqual(["quick"]);
  });

  it("does not repeat a mode two groups both mention", () => {
    expect(skillModes("[a | b] [b | c]")).toEqual(["a", "b", "c"]);
  });
});

describe("the short name a team uses", () => {
  const { shortName } = require("../../shared/cardSkills.ts") as typeof import("../../shared/cardSkills.ts");

  it("takes the prefix the title already carries", () => {
    // "waiting on T2" is something to act on; "waiting on ABC-21016" is a
    // lookup somebody has to perform before the sentence means anything.
    expect(shortName("T16 - Non-destructive price rollout", "ABC-1")).toBe("T16");
    expect(shortName("T2 – Refund endpoint", "ABC-1")).toBe("T2");
    expect(shortName("QA9: verify the thing", "ABC-1")).toBe("QA9");
  });

  it("falls back to the id rather than inventing a name", () => {
    for (const t of ["Fix the login bug", "", "12345 - numeric only", "A very long prefix - x"]) {
      expect(shortName(t, "ABC-1"), JSON.stringify(t)).toBe("ABC-1");
    }
  });
});
