/*
 * THE PERSON'S OWN BROWSER IS REFUSED TO AN AGENT'S CREDENTIAL AT THE RELAY.
 *
 * The CLI refuses it too, and that refusal is a courtesy: it reads
 * `AGENTGLASS_ROLE` from the worker's own shell, so `AGENTGLASS_ROLE=
 * agentglass-browser --as '(default)' read` gets through. What a caller can
 * unset in its shell is not a boundary. These are the two halves of the one
 * that is: the relay reads the credential it authenticated, and the identity
 * has as many spellings on the wire as the CLI has flags.
 */
import { describe, expect, test } from "bun:test";
import { agentAskRefusal, namesThePerson } from "../src/browserdrive.ts";

describe("every spelling of the person's container on the wire", () => {
  test("the CLI's own forms", () => {
    // `--shared` sends no `as` at all, and `--as "(default)"` is the same
    // identity with a name on it (the CLI's SHARED_KEY).
    expect(namesThePerson({ how: "shared" })).toBe(true);
    expect(namesThePerson({ as: "(default)" })).toBe(true);
    expect(namesThePerson({ as: " (DEFAULT) " })).toBe(true);
    expect(namesThePerson({ as: "(default)", page: "t9-ef01" })).toBe(true);
  });

  test("the forms that do not say the name at all", () => {
    expect(namesThePerson({ active: true })).toBe(true); // the tab in front, whoever owns it
    expect(namesThePerson({ shared: true })).toBe(true); // the MCP's own spelling
    expect(namesThePerson({ profile: "" })).toBe(true); // `open` names the empty container
    expect(namesThePerson({ container: "shared", lane: "l1" })).toBe(true); // a lane in it
  });

  test("a worker's own identity is not the person's", () => {
    expect(namesThePerson({ as: "orbit-1", how: "own-container" })).toBe(false);
    expect(namesThePerson({ profile: "orbit-1" })).toBe(false);
    expect(namesThePerson({ container: "named", name: "orbit-1" })).toBe(false);
    // A page cannot be placed by the gate: the tab may live in the person's
    // container, so it is refused whatever identity is beside it (Should 1).
    expect(namesThePerson({ as: "orbit-1", page: "t9-ef01", how: "explicit-page" })).toBe(true);
  });
});

describe("the refusal", () => {
  test("names the credential and says what to do instead", () => {
    const msg = agentAskRefusal({ how: "shared" })!;
    expect(msg).toContain("minted for an agent");
    expect(msg).toContain("--as <name>");
    expect(agentAskRefusal({ as: "orbit-1" })).toBeNull();
  });
});
