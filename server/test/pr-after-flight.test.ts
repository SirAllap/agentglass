/*
 * A forced read is not answered by one that began before it. `afterFlight` runs
 * the forced read when the one in flight has ended, once for any number of
 * presses, and survives that one failing.
 */
import { describe, expect, test } from "bun:test";
import { afterFlight } from "../src/prs.ts";

describe("afterFlight", () => {
  test("runs after the flight, not during it, and once for several presses", async () => {
    const order: string[] = [];
    let end!: () => void;
    const flying = new Promise<string>((r) => { end = () => { order.push("flight ends"); r("old"); }; });
    const follows = new Map<string, Promise<string>>();
    const run = async () => { order.push("forced read"); return "new"; };
    const a = afterFlight(follows, "k", flying, run);
    const b = afterFlight(follows, "k", flying, run);
    expect(a).toBe(b);
    expect(order).toEqual([]);
    end();
    expect(await a).toBe("new");
    expect(order).toEqual(["flight ends", "forced read"]);
    expect(follows.size).toBe(0);
  });
  test("a failed flight does not stop the forced read", async () => {
    const out = await afterFlight(new Map(), "k", Promise.reject(new Error("gh blinked")), async () => "new");
    expect(out).toBe("new");
  });
});
test("prDetail sends a late forced read through it", async () => {
  const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
  const at = src.indexOf("export async function prDetail(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  expect(body).toMatch(/afterFlight\(detailFollows, key, flying/);
});
