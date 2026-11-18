/* A card with no words leaves the person with a highlight and nothing to do: point refuses it, with a sentence. */
import { describe, expect, test } from "bun:test";
import { parseAsk } from "../src/browserdrive.ts";

describe("point needs words", () => {
  for (const say of ["", "   ", "\n\t "]) {
    test(`say ${JSON.stringify(say)} is refused`, () => {
      const r = parseAsk("point", { selector: "e1", say });
      expect("error" in r && r.error).toBe("point needs say: what the person should do there (at most 2000 characters)");
    });
  }
  test("real words pass, trimmed", () => {
    const r = parseAsk("point", { selector: "e1", say: "  Open keys.  " });
    expect("ask" in r && r.ask.args.say).toBe("Open keys.");
  });
});
