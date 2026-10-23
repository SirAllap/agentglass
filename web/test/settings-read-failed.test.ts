import { describe, expect, test } from "bun:test";

const src = (f: string) => Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text();
const clickup = await src("ClickUpPane.tsx");
const teach = await src("understudy/Teach.tsx");

/* With the server down, two pages said "Reading …" until the window closed: the read answered null and nothing
   remembered that it had. Each now keeps the failure and draws it, with a way to ask again. */
describe("a read that fails is drawn, not left as a loading line", () => {
  test("ClickUp keeps a failed read of its prefs and offers Try again", () => {
    const body = clickup.slice(clickup.indexOf("export function ClickUpPane("));
    expect(body).toContain("setPrefsFailed(true)");
    expect(body).toContain("Could not read your ClickUp settings");
    expect(body).toContain("Try again");
  });
  test("Knowledge keeps a failed read of its sources and offers Try again", () => {
    const body = teach.slice(teach.indexOf("export function Teach("));
    expect((body.match(/setLoadFailed\(true\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("Could not read what is on this machine");
    expect(body).toContain("Try again");
  });
});
