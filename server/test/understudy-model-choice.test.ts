/*
 * Which model runs a task, and what the remaining allowance does to it.
 *
 * Every run before this launched `claude -p` with no `--model`, so a two-line
 * rename and a whole-feature audit both went to the account's default — the
 * most expensive model there is, out of a weekly allowance shared with the
 * person whose account it is.
 *
 * His rule, in his own words: haiku when the work is "almost a copy and
 * paste", sonnet for the middle, opus "for things where I want it to do a
 * really top-notch analysis". And one prohibition that is not about quality: Fable is
 * never used here, because that allowance is what he needs for his own work.
 */
import { describe, expect, test } from "bun:test";
import { chooseModel, FORBIDDEN_MODELS } from "../src/understudy-model.ts";

const full = { weekRemaining: 90, hourRemaining: 100 };
const thin = { weekRemaining: 8, hourRemaining: 100 };
const mid = { weekRemaining: 25, hourRemaining: 100 };
/** A young week, and twenty minutes left of the five-hour window. */
const lateInTheWindow = { weekRemaining: 90, hourRemaining: 6 };

describe("the task asks for a tier", () => {
  test("work that has to be worked out asks for the top one", () => {
    for (const t of ["Audit the loop for dead code", "Decide whether to add a plugin system",
                     "Diagnose why runs stop at 45 minutes", "Design the parallel scheme"]) {
      expect(chooseModel({ title: t, usage: full }).model, t).toBe("opus");
    }
  });

  test("work that is applying a known change asks for the cheapest", () => {
    for (const t of ["Rename the posture local to guarded", "Fix the typo in the tab label",
                     "Reword the empty state"]) {
      expect(chooseModel({ title: t, usage: full }).model, t).toBe("haiku");
    }
  });

  test("and everything else sits in the middle", () => {
    expect(chooseModel({ title: "Add a test for discardRun", usage: full }).model).toBe("sonnet");
  });

  test("a copy edit is a copy edit even when it names an expensive thing", () => {
    /*
     * The three that were measured coming back as opus with 90% of the week
     * left, because the "work it out" pattern was tested first and matched a
     * NOUN: `migrat`, `security`, `analys`. Each one is a copy edit, and each
     * one was being paid for at the top tier out of his allowance.
     */
    for (const t of ["Fix the typo in the migration guide",
                     "Rename the security banner copy",
                     "Reword the comment about why we analyse"]) {
      expect(chooseModel({ title: t, usage: full }).model, t).toBe("haiku");
    }
  });

  test("and something that really is an audit still gets the top tier", () => {
    // The order it now tests in must not take the expensive words away from
    // the tasks that are actually expensive.
    for (const t of ["Audit the token minting for a way out",
                     "Decide whether the five-hour window should stop a run",
                     "Investigate the security of the read-only credential"]) {
      expect(chooseModel({ title: t, usage: full }).model, t).toBe("opus");
    }
  });
});

describe("the whole task is read, not the title", () => {
  /*
   * MEASURED: the only call site passed `detail: ""`, so a card was classified
   * from one line of title while the body — the part that says whether this is
   * a rename or an audit — went to the brief and not to the chooser. His cards
   * are a short title with the substance underneath it.
   */
  test("the body can say the work is harder than the title admits", () => {
    const c = chooseModel({
      title: "Have a look at the loop",
      detail: "Audit every path that can leave a run at `running` and decide which of them is worth a stop rule.",
      usage: full,
    });
    expect(c.model).toBe("opus");
  });

  test("and it can say the work is a copy edit when the title does not", () => {
    const c = chooseModel({
      title: "The banner on the security page",
      detail: "Reword it: the copy says 'analyse' and it should say 'check'. Nothing else changes.",
      usage: full,
    });
    expect(c.model).toBe("haiku");
  });

  test("the same title with no body is the title, and nothing breaks", () => {
    expect(chooseModel({ title: "Audit the loop", usage: full }).model).toBe("opus");
  });
});

describe("the call site hands over the body", () => {
  /*
   * The defect was never in `chooseModel`, which has taken a `detail` from the
   * beginning — it was in the one line that called it with `""`. A unit test
   * of a pure function cannot see that, so this reads the caller.
   */
  test("index.ts passes the card body to the chooser", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const call = src.match(/chooseModel\(\{[^}]*\}\)/);
    expect(call, "chooseModel should still be called from index.ts").toBeTruthy();
    expect(call![0]).toContain("detail:");
    expect(call![0], "a hard-coded empty body is the bug this fixed").not.toMatch(/detail:\s*""/);
  });
});

describe("the allowance can only lower it", () => {
  /*
   * The asymmetry is the whole design. A mechanical edit is never promoted
   * because the week happens to be young; a hard one is demoted when it is
   * nearly over. Promotion would spend more for no reason; demotion spends
   * less for a good one.
   */
  test("a thin week caps even an audit at the cheapest", () => {
    expect(chooseModel({ title: "Audit everything", usage: thin }).model).toBe("haiku");
  });

  test("a middling week caps it at the middle", () => {
    expect(chooseModel({ title: "Audit everything", usage: mid }).model).toBe("sonnet");
  });

  test("a young week does NOT promote a rename", () => {
    expect(chooseModel({ title: "Rename a variable", usage: full }).model).toBe("haiku");
  });

  test("no reading is not a reason to spend as if it were full", () => {
    // The failure direction that matters: a meter that cannot be read must
    // not be treated as 100%.
    expect(chooseModel({ title: "Audit everything", usage: null }).model).toBe("sonnet");
  });
});

describe("the five-hour window is a meter too, and it is read", () => {
  /*
   * It was carried on `UsageNow`, filled in by `usageNow()` and read by
   * nothing. So a run could start at opus/high with 6% of the window left,
   * die in the middle of the work, and record a failure that said nothing
   * about why — while the week's meter, the one that had not run out, sat
   * there at 90%.
   */
  test("a window that is nearly over caps the model, whatever the week says", () => {
    const c = chooseModel({ title: "Audit everything", usage: lateInTheWindow });
    expect(c.model).toBe("haiku");
  });

  test("and it lowers the effort before it lowers the model", () => {
    // 30% of the window is not thin enough to change the tier, and is thin
    // enough that a long think is what fails to finish inside it.
    const c = chooseModel({ title: "Audit everything", usage: { weekRemaining: 90, hourRemaining: 30 } });
    expect(c.model).toBe("opus");
    expect(c.effort).toBe("medium");
  });

  test("it never raises anything: a thin week still wins", () => {
    const c = chooseModel({ title: "Audit everything", usage: { weekRemaining: 8, hourRemaining: 100 } });
    expect(c.model).toBe("haiku");
    expect(c.effort).toBe("low");
  });

  test("and the sentence names the window when the window is what did it", () => {
    // A capped run that cannot say which meter capped it is the failure this
    // reading exists to prevent.
    const c = chooseModel({ title: "Audit everything", usage: lateInTheWindow });
    expect(c.why).toMatch(/five-hour window/);
    expect(c.why).toContain("6%");
  });

  test("a full window says nothing, because it explains nothing", () => {
    expect(chooseModel({ title: "Audit everything", usage: full }).why).not.toContain("five-hour");
  });
});

describe("effort follows, and fable never runs", () => {
  test("the last of the week is spent thinking less, not worse", () => {
    expect(chooseModel({ title: "Audit everything", usage: thin }).effort).toBe("low");
    expect(chooseModel({ title: "Audit everything", usage: full }).effort).toBe("high");
  });

  test("fable is not a value this can return", () => {
    expect(FORBIDDEN_MODELS).toContain("fable");
    for (const u of [full, mid, thin, null]) {
      for (const t of ["audit", "rename", "add a test"]) {
        expect(chooseModel({ title: t, usage: u }).model).not.toBe("fable");
      }
    }
  });

  test("every choice explains itself, so it can be argued with", () => {
    const c = chooseModel({ title: "Audit everything", usage: mid });
    expect(c.why).toContain("opus");     // what the task asked for
    expect(c.why).toContain("sonnet");   // what it got
    expect(c.why).toMatch(/\d+% of the week/);
  });
});
