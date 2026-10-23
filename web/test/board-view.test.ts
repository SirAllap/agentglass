import { describe, expect, test } from "bun:test";
import { boardView } from "../src/lib/boardView.ts";

describe("boardView", () => {
  test("no answer yet is loading, never empty", () => {
    expect(boardView({ data: null })).toBe("loading");
  });
  test("a real empty answer is ready", () => {
    expect(boardView({ data: { tasks: [] } })).toBe("ready");
  });
  test("a failed read with no rows is an error", () => {
    expect(boardView({ data: { tasks: [], error: "Could not reach the server" } })).toBe("error");
  });
  test("a failed re-read keeps its rows", () => {
    expect(boardView({ data: { tasks: [{}], error: "x" } })).toBe("ready");
  });
});
