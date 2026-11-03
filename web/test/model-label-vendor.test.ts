import { describe, expect, test } from "bun:test";
import { modelLabelOf, providerOf } from "../../shared/models.ts";

// "deepseek-v4.1-flash" holds the generic "flash" fragment: the Crew card said Gemini Flash over a tooltip that said DeepSeek.
describe("a vendor name wins over the generic flash fragment", () => {
  test("DeepSeek flash is DeepSeek, by label and by provider", () => {
    expect(modelLabelOf("opencode-go/deepseek-v4.1-flash")).toBe("DeepSeek");
    expect(providerOf("opencode-go/deepseek-v4.1-flash")).toBe("DeepSeek");
  });
  test("Gemini flash is still Gemini", () => {
    expect(modelLabelOf("gemini-2.0-flash")).toBe("Gemini Flash");
    expect(providerOf("gemini-2.0-flash")).toBe("Google");
  });
});
