import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { USAGE_KEY_GUIDE } from "../src/lib/usageKeyGuide.ts";

const component = readFileSync(new URL("../src/components/engines/UsageKeyCard.tsx", import.meta.url), "utf8");

describe("the OpenCode usage key field", () => {
  test("says how to make a key, and what to do about a 403", () => {
    expect(USAGE_KEY_GUIDE).toContain("Personal API keys");
    expect(USAGE_KEY_GUIDE).toContain("Usage = Read");
    expect(USAGE_KEY_GUIDE).toContain("Models stays None");
    expect(USAGE_KEY_GUIDE).toContain("Budgets = Read");
  });

  test("is a password field with a Clear button, and never a stored value shown back", () => {
    expect(component).toContain('type="password"');
    expect(component).toContain(">Clear<");
    expect(component).toContain("openCodeKey()");
  });
});
