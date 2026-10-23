import { describe, expect, test } from "bun:test";
import { epicName } from "../src/jiraBoardContext.ts";

describe("an epic's name on a board", () => {
  test("the Epic Name wins when the project fills it", () => {
    expect(epicName({ name: "Area: Mobile", summary: "Some title" }, "ORBIT-1000")).toBe("Area: Mobile");
  });
  test("an empty Epic Name falls back to the issue title, not to the key", () => {
    expect(epicName({ name: "", summary: "[EPIC] Design system (tokens, components)" }, "ORBIT-1042"))
      .toBe("[EPIC] Design system (tokens, components)");
    expect(epicName({ summary: "Checkout" }, "ORBIT-1042")).toBe("Checkout");
  });
  test("the key only when neither exists", () => {
    expect(epicName({}, "ORBIT-1042")).toBe("ORBIT-1042");
    expect(epicName({ name: 7, summary: null }, "ORBIT-1042")).toBe("ORBIT-1042");
  });
});
