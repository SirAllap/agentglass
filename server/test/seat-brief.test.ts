/*
 * THE WORKER'S BRIEF — the half that was missing, and why it is a file.
 *
 * Modelled on an interview with an orchestrator that has run for a day on a
 * real project. It has no doctrine file at all; what makes it work is the
 * paragraph it sends to every agent and the fixed shape it demands back. So
 * these tests are about that paragraph existing, being editable, and carrying
 * the four rules that were paid for rather than designed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-brief-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");
/* The open project, so `seatable` lets these through: its gate fires first and
   would otherwise answer every adoption test with "not a project this app
   knows", which is a true answer to a different question. */
process.env.AGENTGLASS_ROOT = join(dir, "adopt-me");

const { briefPath, briefTemplate, readBrief, writeBrief, REPORT_SHAPE, MAX_BRIEF } = await import("../src/seatbrief.ts");
const { doctrinePath } = await import("../src/seatdoctrine.ts");
const Seat = await import("../src/seat.ts");
const { db } = await import("../src/db.ts");

const ROOT = join(dir, "orbit");

describe("two files, because they govern two different people", () => {
  test("the brief sits beside the doctrine and is not the same file", () => {
    expect(briefPath(ROOT)).not.toBe(doctrinePath(ROOT));
    expect(briefPath(ROOT).startsWith(doctrinePath(ROOT).replace(/\.md$/, ""))).toBe(true);
  });

  test("it is seeded once and read back after", () => {
    const first = readBrief(ROOT);
    expect(first.seeded).toBe(true);
    writeBrief(ROOT, "# mine\n\nonly my rules\n");
    const second = readBrief(ROOT);
    expect(second.seeded).toBe(false);
    expect(second.text).toBe("# mine\n\nonly my rules\n");
  });

  test("an empty one is refused, and the file on disk survives the refusal", () => {
    const root = join(dir, "empty");
    readBrief(root);
    expect(writeBrief(root, "  ").ok).toBe(false);
    expect(readFileSync(briefPath(root), "utf8")).toContain("report to the orchestrator");
    expect(writeBrief(root, "x".repeat(MAX_BRIEF + 1)).ok).toBe(false);
  });
});

describe("the rules in it that were paid for", () => {
  const text = briefTemplate("/home/a/code/orbit");

  test("the one rule everything follows from", () => {
    expect(text).toContain("If what a colleague can see changes, it is not yours");
  });

  test("a peer cannot lift the gate", () => {
    /* Measured on a real machine: an instruction relayed by another agent was
       refused by the agents it reached, and the owner backed them. */
    expect(text.toLowerCase()).toContain("peer cannot lift that gate");
  });

  test("approved is not a review until you can say who", () => {
    expect(text).toContain("not a review until you can say WHO");
  });

  test("check the branch has what the change needs", () => {
    expect(text).toContain("check the branch actually has what");
  });

  test("an idle agent with a watcher bills like a working one", () => {
    expect(text).toContain("idle agent with a\n  watcher");
  });

  test("and it names the report shape, once", () => {
    expect(text).toContain(REPORT_SHAPE);
    expect(REPORT_SHAPE).toContain("STATE / BLOCKED / NEED / COST");
  });
});

describe("the seat is told to hand it out", () => {
  test("only where it may open agents", () => {
    /* A chair that may not start anything has nobody to brief, and a rule it
       cannot act on is noise in the most expensive context on the machine. */
    expect(Seat.houseBlock("speak", 4, ROOT)).not.toContain("worker brief");
    expect(Seat.houseBlock("assign", 4, ROOT)).toContain("worker brief");
  });

  test("with the path to this project's own copy", () => {
    expect(Seat.houseBlock("assign", 4, ROOT)).toContain(briefPath(ROOT));
  });

  test("and with one report shape, not two spellings of it", () => {
    expect(Seat.houseBlock("assign", 4, ROOT)).toContain(REPORT_SHAPE);
  });
});

describe("adopting an orchestrator that was already working", () => {
  /*
   * The case this exists for: a session had been running a real project for a
   * day, with five agents reporting to it, when the seat was built. "Take the
   * seat" would have replaced it with a stranger.
   */
  const ROOT2 = join(dir, "adopt-me");

  test("a pane id that is not one is refused before anything is written", async () => {
    const r = await Seat.adoptSeat({ root: ROOT2, session: "s-x", pane: "not-a-pane" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("pane id");
    expect(Seat.seatRow(ROOT2)).toBeNull();
  });

  test("a pane nobody can find is refused too", async () => {
    /* No tmux in a test, so every id is absent — which is the answer this
       check exists to give: adopting a pane that is not there would claim
       somebody is minding a project when nobody is. */
    const r = await Seat.adoptSeat({ root: ROOT2, session: "s-x", pane: "%99999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no such pane");
  });

  test("standing down an adopted seat does not kill it", async () => {
    /* Written straight to the row, because the live check needs a tmux this
       test does not have. What is under test is the branch in closeSeat. */
    db.query(`INSERT INTO seat (root, name, powers, adopted_session, adopted_pane, started_at)
              VALUES (?, 'orchestrator', 'assign', 's-real', '%77', 1)
              ON CONFLICT(root) DO UPDATE SET adopted_pane = '%77'`).run(ROOT2);
    expect(Seat.seatRow(ROOT2)?.adoptedPane).toBe("%77");
    await Seat.closeSeat(ROOT2);
    /* The claim is dropped; the session it pointed at is somebody else's day
       and is not killed by a button that says "stand down". */
    expect(Seat.seatRow(ROOT2)?.adoptedPane).toBe("");
    expect(Seat.seatRow(ROOT2)?.lastLine).toBeDefined();
  });
});

describe("over its shoulder shows work, not furniture", () => {
  /*
   * Measured on a real pane: the last eight non-empty lines were the input
   * box, a spinner, a permission footer and a hook printing MEMORY REMINDER.
   * Eight lines of chrome and not one of work, which is a panel with no
   * reason to exist.
   */
  const PANE = [
    "  ⏺ Read src/export.ts",
    "  ⏺ Bash(bun test server/test/export.test.ts)",
    "    4 pass, 0 fail",
    "",
    "└ UserPromptSubmit says: MEMORY REMINDER: It's been over 15 minutes since your last save.",
    "· Billowing… (29s · ↓ 213 tokens · still thinking with xhigh effort)",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  test("keeps what the agent did", () => {
    const out = Seat.shoulder(PANE);
    expect(out).toContain("bun test server/test/export.test.ts");
    expect(out).toContain("4 pass, 0 fail");
  });

  test("drops the box, the spinner, the footer and the hook", () => {
    const out = Seat.shoulder(PANE);
    expect(out).not.toContain("MEMORY REMINDER");
    expect(out).not.toContain("Billowing");
    expect(out).not.toContain("bypass permissions");
    expect(out).not.toContain("❯");
  });

  test("a pane with nothing but chrome says nothing at all", () => {
    /* An empty box is more honest than a box full of furniture, and the view
       does not draw one. */
    expect(Seat.shoulder("❯ \n  ⏵⏵ bypass permissions on\n")).toBe("");
    expect(Seat.shoulder("")).toBe("");
  });

  test("cuts at the LAST box, so a quoted one does not hide the work", () => {
    const out = Seat.shoulder(["❯ old prompt", "  ⏺ did the thing", "❯ "].join("\n"));
    expect(out).toContain("did the thing");
  });
});
