import { describe, expect, test } from "bun:test";
import { deskGated } from "../src/lib/deskGate.ts";

/* The server refuses merge, close and approving a contributor's held
   workflows unless the request carries the desk key (personOnlyPrRefusal).
   These four were missing from the desk-gated list, so the person's own click
   in the app went out without the key and came back "an agent cannot". */
describe("person-only PR actions carry the desk key", () => {
  for (const p of ["/prs/merge", "/prs/close", "/prs/unstick-close", "/prs/approve-runs"]) {
    test(p, () => expect(deskGated(p)).toBe(true));
  }
});
