/*
 * One read of a list's people for the whole page: held a minute, in flight once however many ask, a failure
 * never kept, and the same answer for the pickers that used to read it on their own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { __forgetListMembers, listMembers } from "../src/lib/listMembers.ts";

const real = api.clickupMembers;
afterEach(() => { (api as { clickupMembers: typeof real }).clickupMembers = real; __forgetListMembers(); });
const stub = (fn: (l: string) => Promise<{ ok: boolean; error?: string; members?: { id: number; name: string; initials: string }[] }>) => { (api as { clickupMembers: unknown }).clickupMembers = fn; };

describe("the people of a list", () => {
  test("asked by several pickers at once, read once", async () => {
    let calls = 0;
    stub(async () => { calls++; await Bun.sleep(5); return { ok: true, members: [{ id: 1, name: "Ada Test", initials: "AT" }] }; });
    const rs = await Promise.all([listMembers("L1"), listMembers("L1"), listMembers("L1")]);
    expect(calls).toBe(1);
    expect(rs.every((r) => r.members?.[0]?.id === 1)).toBe(true);
  });
  test("asked again within the minute, answered from the page's copy; another list is its own read", async () => {
    let calls = 0;
    stub(async (l) => { calls++; return { ok: true, members: [{ id: l === "L1" ? 1 : 2, name: l, initials: "X" }] }; });
    await listMembers("L1"); await listMembers("L1");
    expect(calls).toBe(1);
    expect((await listMembers("L2")).members?.[0]?.id).toBe(2);
    expect(calls).toBe(2);
  });
  test("a failure is not kept: the next ask tries again", async () => {
    let calls = 0;
    stub(async () => { calls++; return calls === 1 ? { ok: false, error: "down" } : { ok: true, members: [{ id: 1, name: "A", initials: "A" }] }; });
    expect((await listMembers("L1")).ok).toBe(false);
    expect((await listMembers("L1")).ok).toBe(true);
    expect(calls).toBe(2);
  });
  test("forgetting it (the credential changed) asks again", async () => {
    let calls = 0;
    stub(async () => { calls++; return { ok: true, members: [] }; });
    await listMembers("L1"); __forgetListMembers(); await listMembers("L1");
    expect(calls).toBe(2);
  });
  test("the pickers read it through here, not on their own", async () => {
    const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
    for (const f of ["components/AssignPicker.tsx", "components/AskedExtras.tsx", "components/MergeDialog.tsx", "components/TasksPanel.tsx"]) {
      expect((await read(f)).match(/api\.clickupMembers\(/g)?.length ?? 0).toBe(0);
    }
  });
});
