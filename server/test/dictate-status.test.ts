/*
 * An oversize recording answered 400 while an oversize image answered 413, so a
 * client could not tell "too big" from "malformed" by the status. Too big is
 * 413 in both; every other refusal stays a 400.
 */
import { describe, expect, test } from "bun:test";
import { transcribe } from "../src/dictate.ts";

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("/terminal/dictate refusals", () => {
  test("a recording over the cap is a 413 with a sentence", async () => {
    const big = Buffer.alloc(12 * 1024 * 1024 + 1).toString("base64");
    const r = await transcribe(big, "talk.m4a");
    expect(r).toMatchObject({ ok: false, status: 413, error: "that recording is too long" });
  });

  test("no audio is not a 413", async () => {
    const r = await transcribe("", "talk.m4a");
    expect(r.ok).toBe(false);
    expect(r.status).toBeUndefined();
  });

  test("the route answers with the status and keeps it out of the body", () => {
    const at = index.indexOf('pathname === "/terminal/dictate"');
    const route = index.slice(at, index.indexOf("\n    }\n", at));
    expect(route).toContain("said.ok ? 200 : status ?? 400");
    expect(route).toContain("const { status, ...body } = said;");
  });
});
