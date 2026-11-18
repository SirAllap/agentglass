import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/jira/detail/LifecycleBlocks.tsx", import.meta.url)).text();

describe("the timeline's role chips", () => {
  test("show only when there are enough events to narrow, and say they narrow", async () => {
    const { ROLE_FILTER_MIN } = await import("../src/components/jira/detail/LifecycleBlocks.tsx");
    expect(ROLE_FILTER_MIN).toBeGreaterThan(2);
    const body = src.slice(src.indexOf("export function Timeline("), src.indexOf("export function LifecycleBlocks("));
    expect(body).toContain("rows.length >= ROLE_FILTER_MIN");
    expect(body).toContain(">Show</span>");
  });
});
