/*
 * The words of a conversation event are shared with the desk, so a phone and a
 * window describe the same push the same way. Every kind has a sentence, and
 * the parts say what is emphasised, not how.
 */
import { describe, expect, test } from "bun:test";
import type { PrEvent } from "../../shared/types.ts";
import { eventParts } from "../../shared/prEventLine.ts";

const say = (e: Partial<PrEvent> & Pick<PrEvent, "kind">): string =>
  eventParts({ at: "2026-09-30T10:00:00Z", actor: "ada", ...e }).map((p) => p.text).join("");

describe("eventParts", () => {
  test("the sentences GitHub uses", () => {
    expect(say({ kind: "force-push", detail: "aaaaaaa → fb1f5ad" })).toBe("ada force-pushed aaaaaaa → fb1f5ad");
    expect(say({ kind: "review-requested", detail: "bob" })).toBe("ada requested a review from bob");
    expect(say({ kind: "labeled", detail: "feature" })).toBe("ada added the feature label");
    expect(say({ kind: "unlabeled", detail: "feature" })).toBe("ada removed the feature label");
    expect(say({ kind: "merged", detail: "main" })).toBe("ada merged this into main");
    expect(say({ kind: "renamed", detail: "Add retry" })).toBe("ada changed the title to “Add retry”");
    expect(say({ kind: "auto-merge-disabled", detail: "a push" })).toBe("ada cancelled auto-merge (a push)");
    expect(say({ kind: "auto-merge-disabled" })).toBe("ada cancelled auto-merge");
  });

  test("the actor is marked as the actor, and somebody when GitHub did not say", () => {
    expect(eventParts({ kind: "closed", at: "", actor: "" })[0]).toEqual({ text: "somebody", as: "who" });
  });

  test("code is what is a ref or a sha; a person named is strong", () => {
    const parts = eventParts({ kind: "review-requested", at: "", actor: "ada", detail: "bob" });
    expect(parts.find((p) => p.as === "strong")?.text).toBe("bob");
    expect(eventParts({ kind: "head-ref-deleted", at: "", actor: "ada", detail: "feat/x" }).find((p) => p.as === "code")?.text).toBe("feat/x");
  });

  test("a kind this version does not know is still a sentence", () => {
    expect(say({ kind: "from-the-future" as PrEvent["kind"] })).toBe("ada did something");
  });
});
