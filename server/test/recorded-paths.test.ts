// The set of checkouts the events table holds was re-read with two DISTINCT
// scans every 30 s — 94-98 ms of cold index pages each time, on the loop. It is
// read once now, grown at ingest, and dropped only when retention deletes.
import { describe, expect, test } from "bun:test";
import { pathSet } from "../src/db.ts";

describe("pathSet", () => {
  test("seeds once however often it is read", () => {
    let seeds = 0;
    const s = pathSet(() => { seeds++; return ["/code/orbit"]; });
    for (let i = 0; i < 5; i++) s.all();
    expect(seeds).toBe(1);
  });

  test("a noted path shows up on the next read, without a reseed", () => {
    let seeds = 0;
    const s = pathSet(() => { seeds++; return ["/code/orbit"]; });
    s.all();
    s.note("/code/orbit-ORBIT-1042");
    s.note("/code/orbit");
    s.note(42);
    s.note("");
    expect(s.all().sort()).toEqual(["/code/orbit", "/code/orbit-ORBIT-1042"]);
    expect(seeds).toBe(1);
  });

  test("a path noted before the first read is not lost to the seed", () => {
    const s = pathSet(() => ["/code/orbit", "/code/orbit-ORBIT-1042"]);
    s.note("/code/orbit-ORBIT-1042");
    expect(s.all().length).toBe(2);
  });

  test("forget makes the next read ask the table again", () => {
    let rows = ["/code/orbit", "/code/gone"];
    const s = pathSet(() => rows);
    expect(s.all().length).toBe(2);
    rows = ["/code/orbit"];
    s.forget();
    expect(s.all()).toEqual(["/code/orbit"]);
  });
});
