import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

const L = await import("../src/lib/useJiraViewLayout.ts");
const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };

describe("the Jira view layout when storage cannot be read", () => {
  beforeEach(() => { L.__resetSharedLayout(); });
  it("an edit starts from the last copy in memory, never from the defaults", () => {
    stubGlobal("localStorage", blocked);
    L.editLayout((l) => ({ ...l, hidden: ["a"] }));
    const second = L.editLayout((l) => ({ ...l, names: { b: "Mine" } }));
    expect(second.hidden).toEqual(["a"]);
    expect(second.names).toEqual({ b: "Mine" });
  });
});
