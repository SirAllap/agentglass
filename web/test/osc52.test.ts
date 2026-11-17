import { describe, expect, test } from "bun:test";
import { osc52Text } from "../src/lib/osc52.ts";

describe("OSC 52 from a worker's CLI", () => {
  test("a write decodes, utf-8 included", () => {
    expect(osc52Text("c;" + btoa("hello"))).toBe("hello");
    expect(osc52Text("c;" + btoa(String.fromCharCode(...new TextEncoder().encode("añ"))))).toBe("añ");
    expect(osc52Text(";" + btoa("x"))).toBe("x");
  });
  test("a query, an empty write or junk copies nothing", () => {
    expect(osc52Text("c;?")).toBeNull();
    expect(osc52Text("c;")).toBeNull();
    expect(osc52Text("c;%%%")).toBeNull();
    expect(osc52Text("nosemi")).toBeNull();
  });
});
