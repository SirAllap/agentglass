/*
 * Who reviews and checks, per project: the three settings the Orchestration
 * page writes, what an agent's change does to each, and the sentence the chair
 * is given for each answer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineReadiness } from "../../shared/types.ts";

const HOME = mkdtempSync(join(tmpdir(), "agx-review-setting-"));
process.env.XDG_CONFIG_HOME = HOME;
process.env.XDG_DATA_HOME = join(HOME, "data");
process.env.AGENTGLASS_STATE_DIR = join(HOME, "state");
process.env.AGENTGLASS_DB = join(HOME, "review.db");
process.env.AGENTGLASS_DOCTRINE = join(HOME, "doctrine");

const { serverSettingDefs } = await import("../src/serverSettings.ts");
const Seat = await import("../src/seat.ts");
const { writeDoctrine } = await import("../src/seatdoctrine.ts");
const { APP, putSetting } = await import("../src/preflightStore.ts");
const { agentVerdict } = await import("../../shared/settingClass.ts");
const { checkSecondReviewer, REVIEW_OVERRIDES } = await import("../../shared/reviewSettings.ts");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const defs = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} });
const def = (id: string) => defs.find((d) => d.id === id)!;
const WHO = "orchestration.review.who";
const ROUNDS = "orchestration.review.rounds";
const SECOND = "orchestration.review.second";
const ROOT = "/work/acme/orbit";

const engine = (id: string, workerOk: boolean): EngineReadiness => ({
  id, title: id, found: true, path: `/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: workerOk, why: workerOk ? undefined : "Not ready here." }, orchestrator: { ok: workerOk } },
  missing: [], envelope: { via: null, enforced: "no", note: "" },
});
const secondDef = (engines: EngineReadiness[]) =>
  serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {}, engineReadiness: async () => engines })
    .find((d) => d.id === SECOND)!;

describe("the three review settings", () => {
  test("are per project, and their defaults are how the app already worked", () => {
    for (const id of [WHO, ROUNDS, SECOND]) expect(def(id).scoped).toBe(true);
    const fresh = "/work/acme/fresh";
    expect(def(WHO).read(fresh)).toBe("second");
    expect(def(ROUNDS).read(fresh)).toBe(3);
    expect(def(SECOND).read(fresh)).toBeNull();
    expect(def(WHO).isSet!(fresh)).toBe(false);
  });

  test("a value is checked, kept for that project only and read back", async () => {
    expect(def(WHO).validate("sometimes", ROOT)).toHaveProperty("error");
    expect(def(ROUNDS).validate(0, ROOT)).toHaveProperty("error");
    expect(def(ROUNDS).validate(7, ROOT)).toHaveProperty("error");
    expect(def(ROUNDS).validate(2.5, ROOT)).toHaveProperty("error");
    expect(await def(SECOND).validate({ engine: "not-an-engine", model: "" }, ROOT)).toHaveProperty("error");
    expect(await def(SECOND).validate({ engine: "claude", model: "two words" }, ROOT)).toHaveProperty("error");

    expect(await def(WHO).apply("second", ROOT)).toEqual({ ok: true });
    expect(await def(ROUNDS).apply(5, ROOT)).toEqual({ ok: true });
    expect(await def(SECOND).apply({ engine: "claude", model: "haiku" }, ROOT)).toEqual({ ok: true });

    expect(def(WHO).read(ROOT)).toBe("second");
    expect(def(ROUNDS).read(ROOT)).toBe(5);
    expect(def(SECOND).read(ROOT)).toEqual({ engine: "claude", model: "haiku" });
    expect(def(WHO).read("/work/acme/other")).toBe("second");
    expect(def(WHO).isSet!(ROOT)).toBe(true);
  });
  test("a second reviewer on an engine that cannot take a worker role is refused", async () => {
    const engines = [engine("claude", false), engine("opencode", true)];
    expect(await secondDef(engines).validate({ engine: "claude", model: "" }, ROOT))
      .toEqual({ error: expect.stringContaining("cannot take a worker role") });
    expect(await secondDef(engines).validate({ engine: "opencode", model: "big" }, ROOT))
      .toEqual({ value: { engine: "opencode", model: "big" } });
  });
});

describe("what an agent's change does", () => {  test("a wider answer on who reads waits for the person, even with the trust switch on", () => {
    expect(agentVerdict(WHO, "never", "second", false)).toBe("ask");
    expect(agentVerdict(WHO, "never", "is", false)).toBe("ask");
    expect(agentVerdict(WHO, "never", "is", true)).toBe("ask");
  });

  test("a narrower answer applies at once", () => {
    expect(agentVerdict(WHO, "is", "second", false)).toBe("apply");
    expect(agentVerdict(WHO, "second", "never", false)).toBe("apply");
  });

  test("more rounds waits; fewer applies at once", () => {
    expect(agentVerdict(ROUNDS, 3, 5, false)).toBe("ask");
    expect(agentVerdict(ROUNDS, 3, 5, true)).toBe("apply");
    expect(agentVerdict(ROUNDS, 5, 3, false)).toBe("apply");
  });

  test("turning the second reviewer off applies at once; turning it on waits", () => {
    expect(agentVerdict(SECOND, null, { engine: "claude", model: "haiku" }, false)).toBe("ask");
    expect(agentVerdict(SECOND, { engine: "claude", model: "haiku" }, null, false)).toBe("apply");
  });
});

describe("the chair's standing instructions", () => {
  test("say which answer it is working under", () => {
    // The default is today's answer: the separate Reviewer reads, then the chair reads the same diff again.
    expect(Seat.houseBlock("speak", 4, join(HOME, "fresh"))).toContain("you then read the same diff as a second review");

    const never = join(HOME, "never");
    putSetting(never, WHO, "never");
    const neverBlock = Seat.houseBlock("speak", 4, never);
    expect(neverBlock).toContain("never read code and never run tests");
    expect(neverBlock).toContain("a worker's report proves");
    expect(neverBlock).not.toContain("is evidence YOU observed");
    expect(neverBlock).not.toContain("a diff, a test run you read");

    const second = join(HOME, "second");
    putSetting(second, WHO, "second");
    expect(Seat.houseBlock("speak", 4, second)).toContain("you then read the same diff as a second review");
    expect(Seat.houseBlock("speak", 4, second)).toContain("is evidence YOU observed");

    const is = join(HOME, "is");
    putSetting(is, WHO, "is");
    expect(Seat.houseBlock("speak", 4, is)).toContain("you are the reviewer");
    expect(Seat.houseBlock("speak", 4, is)).toContain("is evidence YOU observed");
  });

  test("a project with no answer inherits the app's", () => {
    putSetting(APP, WHO, "never");
    expect(def(WHO).read("/work/acme/inherits")).toBe("never");
    putSetting(APP, WHO, "second");
  });

  test("carry the round cap", () => {
    const root = join(HOME, "rounds");
    putSetting(root, ROUNDS, 5);
    expect(Seat.houseBlock("speak", 4, root)).toContain("at most 5 rounds");
  });

  test("name the second reviewer, when one is set", () => {
    const root = join(HOME, "second-reviewer");
    putSetting(root, SECOND, JSON.stringify({ engine: "claude", model: "haiku" }));
    const block = Seat.houseBlock("speak", 4, root);
    expect(block).toContain("A second reviewer reads the same diff on Claude Code (haiku)");
  });
});

/*
 * The chair reads the doctrine first and the house block second, so both are
 * composed here. The evidence rule is the answer's, not the doctrine's: `never`
 * must not be handed a chair that is told to observe a diff.
 */
describe("the whole chair prompt, for every answer", () => {
  /* Affirmative instructions to inspect a change. A negated one ("you never
     open a diff") is the setting speaking, not a contradiction. */
  const OBSERVE = [
    "Evidence you observed",
    "a diff, a test run you read",
    "read the diff",
    "read the same diff",
    "look at the head",
    "open the picture",
  ];
  const compose = async (root: string, who: "never" | "second" | "is") => {
    putSetting(root, WHO, who);
    return (await Seat.seatPrompt(root, "speak", 4)).prompt;
  };

  test("a fresh project on `never` is told to ask its workers, never to look", async () => {
    const prompt = await compose(join(HOME, "prompt-never"), "never");
    expect(prompt).toContain("you never read code and never run tests");
    expect(prompt).toContain("a worker's report proves");
    for (const phrase of OBSERVE) expect(prompt).not.toContain(phrase);
  });

  test("`second` and `is` compose the observing chair", async () => {
    for (const who of ["second", "is"] as const) {
      const prompt = await compose(join(HOME, `prompt-${who}`), who);
      expect(prompt).toContain("a diff, a test run you read");
      expect(prompt).toContain("look at the head");
      expect(prompt).not.toContain("you never read code and never run tests");
    }
  });

  test("a doctrine file already on disk loses to the answer, which comes after it and says so", async () => {
    const root = join(HOME, "prompt-own-doctrine");
    // An old seed, or a person's own file: the same sentence the setting contradicts.
    writeDoctrine(root, "# Our rules\n\nThe evidence rule: Evidence you observed: a commit, a diff, a test run you read.\n");
    const prompt = await compose(root, "never");
    const theirs = prompt.indexOf("Evidence you observed");
    const ours = prompt.indexOf(REVIEW_OVERRIDES);
    expect(theirs).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(theirs);
    expect(prompt.slice(ours)).toContain("you never read code and never run tests");
  });
});

describe("the documented CLI value for the second reviewer", () => {
  test("the JSON an agent types is the value the setting keeps", () => {
    expect(checkSecondReviewer('{"engine":"claude","model":""}')).toEqual({ value: { engine: "claude", model: "" } });
    expect(checkSecondReviewer('  {"engine":"opencode","model":"big"} ')).toEqual({ value: { engine: "opencode", model: "big" } });
    expect(checkSecondReviewer("null")).toEqual({ value: null });
    expect(checkSecondReviewer("")).toEqual({ value: null });
    expect(checkSecondReviewer("not json")).toHaveProperty("error");
  });
});
