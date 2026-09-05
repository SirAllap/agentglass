/*
 * Which principal released the hold — not just that something did.
 *
 * A gate stops a tool call and holds it until somebody says go. Everything it
 * is worth rests on the party being held not being able to release itself, and
 * on the record afterwards being able to say who did. Both halves were soft:
 *
 *   - `actorOf` answered "local" for every caller on loopback, so the person
 *     pressing the button in the desktop app and a process on the same machine
 *     presenting the shared token — which is in an agent's own environment and
 *     readable on disk — produced the same audit line, byte for byte.
 *   - `defaultReason` then told the stopped model "A human reviewed this call
 *     in agentglass and approved it", whoever had released it.
 *
 * So the two things the record exists to establish were the two it could get
 * wrong together, and in the same direction: nobody looked, and the log and the
 * model both said somebody had.
 *
 * The regression that matters most is in here too, and it is the last describe:
 * a decision a person actually makes has to come out exactly as it did before,
 * on every route and in both surfaces. A log that relabels the human as a
 * machine is wrong on nearly every row; the bug above is wrong on the rare one.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorOf, deviceActor, isMachineActor, MACHINE_ACTOR } from "../src/actions.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-principal-"));
process.env.AGENTGLASS_DB = join(dir, "principal.db");
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let gate: typeof import("../src/gate.ts");
beforeAll(async () => {
  db = await import("../src/db.ts");
  gate = await import("../src/gate.ts");
});

let n = 0;
/** A gate row, held. Uuid-shaped because gate.ts refuses anything else. */
function held(): string {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  db.recordGate({
    id, source_app: "claude", session_id: "s1", tool_name: "Bash",
    summary: "rm -rf build", created: Date.now(), expires: Date.now() + 60_000,
  });
  return id;
}
const row = (id: string) => db.getGate(id)!;

/** The desk: the app's own page, on this machine, carrying the shared token. */
const desk = { kind: "machine" as const, fromPage: true };
/** The same token from something that is not a page — a hook, the CLI, an
 *  agent's `curl`. This is the caller the whole file is about. */
const bare = { kind: "machine" as const, fromPage: false };
const phone = { kind: "device" as const, device: { id: "3f9c21aa11", label: "iPhone" } };

describe("the three principals, in the audit line", () => {
  test("the desk, a phone and the shared token are three different strings", () => {
    // All three arrive on loopback in the normal case — the desktop app, the
    // phone through a tunnel, a script on the box — so the address separates
    // none of them and the credential has to.
    const lines = [actorOf("127.0.0.1", desk), actorOf("127.0.0.1", phone), actorOf("127.0.0.1", bare)];
    expect(new Set(lines).size, lines.join(" / ")).toBe(3);
    expect(lines[0]).toBe("local");
    expect(lines[1]).toBe("iPhone · 3f9c21");
    expect(lines[2]).toBe("machine token · local");
  });

  test("and the shared token says so wherever it came from", () => {
    // The address is kept inside the name rather than replaced by it: off-box,
    // *which* machine still matters, and it is the only thing left that
    // narrows a credential the whole network could be holding.
    expect(actorOf("192.168.1.9", bare)).toBe("machine token · 192.168.1.9");
    // Mapped IPv4, which is how a dual-stack listener reports the same caller.
    expect(actorOf("::ffff:192.168.1.9", bare)).toBe("machine token · 192.168.1.9");
  });

  test("a phone cannot take the name by pairing itself under it", () => {
    // The label is free text somebody types at pairing, and it is the only part
    // of this vocabulary written from outside. A device called "machine token"
    // would produce a line that reads as the shared credential — and worse, the
    // model would then be told nobody had reviewed a call a person approved
    // from their phone. The label is dropped; the device is still named.
    const borrowed = deviceActor({ id: "3f9c21aa11", label: MACHINE_ACTOR });
    expect(borrowed).toBe("device · 3f9c21");
    expect(isMachineActor(borrowed)).toBe(false);
    // Case is not a way round it either.
    expect(isMachineActor(deviceActor({ id: "3f9c21aa11", label: "Machine Token" }))).toBe(false);
  });

  test("and a caller that never said how it arrived is answered as it always was", () => {
    // The seam is three-state on purpose. Every route that has not been taught
    // to look passes no flag, and until it does, the address is what the line
    // has always meant — see ActorSource. Read as "not a page", these would all
    // relabel the person at the desk as a machine.
    expect(actorOf("127.0.0.1", { kind: "machine" })).toBe("local");
    expect(actorOf("192.168.1.9", { kind: "machine" })).toBe("192.168.1.9");
    expect(actorOf("127.0.0.1")).toBe("local");
    expect(actorOf(null)).toBe("local");
  });
});

describe("what the stopped model is told", () => {
  test("the shared token is not described as a human", () => {
    // The sentence that made the bug worth fixing rather than merely wrong: an
    // agent that released its own held call was handed a paragraph saying a
    // person had reviewed it, which is the one fact it cannot check.
    for (const d of ["allow", "deny"] as const) {
      const said = gate.defaultReason(d, "machine token · local");
      expect(said, d).not.toContain("A human reviewed");
      expect(said, d).toContain("this machine's own token");
      expect(said, d).toContain("not by a person");
    }
  });

  test("and is still told what to do next", () => {
    // Accuracy is not an excuse to drop the advice. A denial the model cannot
    // act on leaves it retrying the identical call or stalling, which is the
    // whole reason this string stopped being "denied from dashboard".
    const denied = gate.defaultReason("deny", "machine token · local");
    expect(denied).toContain("Do not retry the same call");
    // An allow that nobody looked at is not a verdict on the approach, and a
    // model that reads it as one starts avoiding a perfectly fine one.
    expect(gate.defaultReason("allow", "machine token · local")).toContain("Nobody reviewed it");
  });

  test("a person gets the words they always got", () => {
    // Pinned as literals rather than compared to themselves: this is the string
    // a model reads on nearly every decision, and the point of the change was
    // that it should keep saying this exactly when it is true.
    const human = {
      allow: "A human reviewed this call in agentglass and approved it.",
      deny: "A human reviewed this call in agentglass and denied it. Do not retry the same call — it will be denied again. Take a different approach, or ask them what they would prefer.",
    };
    for (const d of ["allow", "deny"] as const) {
      // The desk, a phone, and a caller nobody classified — every principal
      // that is not the shared token.
      expect(gate.defaultReason(d, "local"), d).toBe(human[d]);
      expect(gate.defaultReason(d, "iPhone · 3f9c21"), d).toBe(human[d]);
      expect(gate.defaultReason(d, null), d).toBe(human[d]);
      expect(gate.defaultReason(d), d).toBe(human[d]);
    }
  });
});

describe("the row and the message, which have to agree", () => {
  test("a decision from the shared token says so in both places", () => {
    // One press, two writers. If the row can name a machine while the model is
    // told a human, the record answers "who approved that" twice and
    // differently, which is worse than not answering.
    const id = held();
    expect(gate.decideGate(id, "allow", "", "machine token · local")).toBe(true);
    expect(row(id).decided_by).toBe("machine token · local");
    expect(row(id).reason).not.toContain("A human reviewed");
    expect(row(id).reason).toBe(gate.defaultReason("allow", "machine token · local"));
  });

  test("and a decision from the desk is unchanged, end to end", () => {
    // The regression this whole change is measured against. Nothing about a
    // person pressing approve moves: not the actor, not the resolution, and not
    // the paragraph the agent reads.
    const id = held();
    expect(gate.decideGate(id, "allow", "", "local")).toBe(true);
    expect(row(id)).toMatchObject({
      decision: "allow",
      resolution: "human",
      decided_by: "local",
      reason: "A human reviewed this call in agentglass and approved it.",
    });
  });

  test("words somebody typed still beat both defaults", () => {
    const id = held();
    gate.decideGate(id, "deny", "not on prod", "machine token · local");
    expect(row(id).reason).toBe("not on prod");
    expect(gate.typedReason(row(id))).toBe("not on prod");
  });

  test("and neither paragraph is quoted back as though somebody had typed it", () => {
    // `typedReason` recognised one default. A second one it did not know would
    // put three lines of boilerplate on every machine-decided row in the
    // history, hiding the row where a person explained themselves — the exact
    // thing that function exists to prevent.
    for (const by of [null, "machine token · local"]) {
      for (const d of ["allow", "deny"] as const) {
        const id = held();
        gate.decideGate(id, d, "", by);
        expect(row(id).reason, `${d} by ${by}`).toBe(gate.defaultReason(d, by));
        expect(gate.typedReason(row(id)), `${d} by ${by}`).toBe("");
      }
    }
  });
});
