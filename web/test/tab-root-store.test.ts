import { describe, expect, test } from "bun:test";
import { onTabRoot, publishTabRoot } from "../src/lib/tabRootStore.ts";

describe("tabRootStore: a re-rooted tab reaches the footer at once", () => {
  test("every subscriber gets the note, an unsubscribed one does not", () => {
    const seen: string[] = [];
    const off = onTabRoot((n) => seen.push(`${n.paneId}:${n.cwd}`));
    publishTabRoot({ paneId: "%64", name: "orbit-tab", cwd: "/code/orbit-ORBIT-1042" });
    off();
    publishTabRoot({ paneId: "%64", name: "orbit-tab", cwd: "/code/elsewhere" });
    expect(seen).toEqual(["%64:/code/orbit-ORBIT-1042"]);
  });
});
