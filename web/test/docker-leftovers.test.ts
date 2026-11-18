// The Docker leftovers pieces of the web: the Images badge decision and the settings helpers.
import { describe, expect, test } from "bun:test";
import { oldCommitSet } from "../src/lib/dockerLeftovers.ts";
import { checkTemplateText, leftoverFieldsOf, listOfText, withLeftovers } from "../src/lib/cleanupSettings.ts";

const HEAD = "a".repeat(7) + "1".repeat(33);

describe("oldCommitSet", () => {
  test("of 4 sha tags, one on a live HEAD, 3 are badged; a tag that is not the template is never badged", () => {
    const refs = [`app:${HEAD.slice(0, 11)}`, "app:1111111", "app:2222222", "app:3333333", "other:4444444"];
    expect([...oldCommitSet([{ template: "app:{sha}", liveHeads: [HEAD] }], refs)]).toEqual(refs.slice(1, 4));
  });
  test("a template without {sha} badges nothing", () => {
    expect(oldCommitSet([{ template: "app:{slug}", liveHeads: [] }], ["app:orbit-1042"]).size).toBe(0);
  });
});

describe("settings helpers", () => {
  test("the template is checked the way the server checks it", () => {
    expect(checkTemplateText("app:{sha}")).toBeNull();
    expect(checkTemplateText("")).toBeNull();
    expect(checkTemplateText("app:latest")).toContain("{slug} or {sha}");
  });
  test("saving the three fields keeps every other field of the stored body", () => {
    const cur = { testDbPrefix: "orbit_", dockerImageTagTemplate: "" };
    const next = withLeftovers(cur, { template: "app:{sha}", patterns: listOfText("app-cache-{slug}\n, app-cache-{slug}"), keep: ["psql-*"] });
    expect(next).toEqual({ testDbPrefix: "orbit_", dockerImageTagTemplate: "app:{sha}", orphanVolumePatterns: ["app-cache-{slug}"], orphanKeep: ["psql-*"] });
    expect(leftoverFieldsOf(next)).toEqual({ template: "app:{sha}", patterns: ["app-cache-{slug}"], keep: ["psql-*"] });
  });
});
