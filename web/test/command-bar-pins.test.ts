import { describe, expect, test } from "bun:test";
import { decodeCustomPin, encodeCustomPin } from "../src/components/CommandBar.tsx";

describe("custom command pins", () => {
  test("round-trip keeps a separate label and exact command", () => {
    const encoded = encodeCustomPin("c", "clear");
    expect(encoded).toStartWith("custom:");
    expect(decodeCustomPin(encoded)).toEqual({ label: "c", cmd: "clear" });
  });

  test("labels and commands with punctuation survive storage encoding", () => {
    const encoded = encodeCustomPin("build & test", "bun test web/foo.test.ts --grep=\"a b\"");
    expect(decodeCustomPin(encoded)).toEqual({ label: "build & test", cmd: "bun test web/foo.test.ts --grep=\"a b\"" });
  });

  test("blank custom pins are rejected and old pins stay ordinary commands", () => {
    expect(encodeCustomPin("", "clear")).toBe("");
    expect(encodeCustomPin("c", "")).toBe("");
    expect(decodeCustomPin("clear")).toBeNull();
    expect(decodeCustomPin("custom:not-json")).toBeNull();
  });
});
