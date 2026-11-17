/*
 * The Review prompts page, asserted against its source (there is no renderer in
 * this project): where its action lives, that no field is a native select, and
 * that the hidden built-ins have a way back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/ReviewPromptsPane.tsx", import.meta.url), "utf8");
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the review prompts page", () => {
  test("New prompt is the page header's action, and the empty states keep their own", () => {
    expect(code).toContain('useReportHead("review-prompts", list && !editing ? { action: { label: "New prompt" } } : null');
    // No second "Write a new prompt" row beside it; only the empty state keeps a button.
    expect(code).not.toContain('label="Write a new prompt"');
    expect(code.match(/>New prompt<\/Button>/g)!.length).toBe(1);
  });

  test("no field is a native select: the kit's themed select draws every list", () => {
    expect(code).not.toMatch(/<select\b/);
    expect(code.match(/<Select\b/g)!.length).toBeGreaterThanOrEqual(8);
    expect(readFileSync(new URL("../src/components/LaunchMode.tsx", import.meta.url), "utf8")).not.toMatch(/<select\b/);
  });

  test("a hidden built-in is listed, and Offer again is the same call as Reset", () => {
    expect(code).toContain("hiddenList");
    expect(code).toContain("onClick={() => void offerAgain(r)}>Offer again");
    const offer = code.slice(code.indexOf("const offerAgain"), code.indexOf("if (!list)"));
    expect(offer).toContain("api.prPromptReset(r.id)");
  });

  test("Edited is the server's word, not a guess made here", () => {
    expect(code).toContain('r.edited ? "Edited" : ""');
  });

  test("the prompt is previewed with a demo pull request and sized in tokens", () => {
    expect(code).toContain("previewParts(r.body, r.group)");
    expect(code).toContain("sizeWords(r.body)");
  });
});
