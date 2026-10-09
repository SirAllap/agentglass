/*
 * What plugins may say about Inbox rows, and the one thing they may not do:
 * make a row disappear. The module decorates; the tests below hold it to
 * returning the rows it was given.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __resetAnnotations, annotate, forgetAnnotations, setAnnotations } from "../src/inbox-annotations.ts";
import { redactSecrets, validateAnnotations, validateContributes, validateFields } from "../../shared/pluginUi.ts";
import type { InboxItem } from "../../shared/types.ts";

const AT = 1_788_000_000_000;
const row = (id: string, at = AT): InboxItem => ({ id, unread: true, reason: "subscribed", type: "PullRequest", repo: "acme/orbit", title: `Thread ${id}`, at });
const declared = { inboxAnnotations: true };

afterEach(() => __resetAnnotations());

describe("annotate", () => {
  test("returns every row, in the order it was given, whatever was posted", () => {
    const rows = [row("1"), row("2"), row("3"), row("4")];
    setAnnotations("orbit-scorer", declared, { items: [
      { id: "1", updatedAt: AT, score: 0 },
      { id: "3", updatedAt: AT, score: 0, badge: { text: "low" } },
      { id: "nobody", updatedAt: AT, score: 1 },
    ] });
    const out = annotate(rows);
    expect(out.map((n) => n.id)).toEqual(["1", "2", "3", "4"]);
    expect(out).toHaveLength(rows.length);
  });

  test("with nothing posted it is the same array", () => {
    const rows = [row("1")];
    expect(annotate(rows)).toBe(rows);
  });

  test("an annotation made for an older version of a row is not shown", () => {
    setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT - 5, score: 0.9 }] });
    expect(annotate([row("1")])[0]!.annotations).toBeUndefined();
    expect(annotate([row("1", AT - 5)])[0]!.annotations).toHaveLength(1);
  });

  test("two plugins each keep their own word", () => {
    setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT, score: 0.9 }] });
    setAnnotations("acme-sorter", declared, { items: [{ id: "1", updatedAt: AT, rank: 7, badge: { text: "mine", tone: "accent" } }] });
    expect(annotate([row("1")])[0]!.annotations!.map((a) => a.plugin)).toEqual(["orbit-scorer", "acme-sorter"]);
  });

  test("a later post replaces the earlier word on the same row, and `replace` drops the plugin's others", () => {
    setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT, score: 0.9 }, { id: "2", updatedAt: AT, score: 0.8 }] });
    setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT, score: 0.2 }] });
    const out = annotate([row("1"), row("2")]);
    expect(out[0]!.annotations![0]!.score).toBe(0.2);
    expect(out[1]!.annotations![0]!.score).toBe(0.8);
    setAnnotations("orbit-scorer", declared, { items: [], replace: true });
    expect(annotate([row("1"), row("2")]).every((n) => n.annotations === undefined)).toBe(true);
  });

  test("a stopped plugin leaves no badge behind", () => {
    setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT, score: 0.9 }] });
    forgetAnnotations("orbit-scorer");
    expect(annotate([row("1")])[0]!.annotations).toBeUndefined();
  });

  test("the store is bounded: the oldest word is the one to go", () => {
    for (let b = 0; b < 3; b++) {
      setAnnotations("orbit-scorer", declared, {
        items: Array.from({ length: 400 }, (_, i) => ({ id: String(b * 400 + i), updatedAt: AT, score: 0.5 })),
      });
    }
    const out = annotate([row("0"), row("1199")]);
    expect(out[0]!.annotations, "the oldest word survived a full store").toBeUndefined();
    expect(out[1]!.annotations).toHaveLength(1);
  });
});

describe("setAnnotations", () => {
  test("refuses a plugin whose manifest did not declare it", () => {
    const r = setAnnotations("orbit-scorer", {}, { items: [{ id: "1", updatedAt: AT, score: 0.9 }] });
    expect(r.ok).toBe(false);
    expect(annotate([row("1")])[0]!.annotations).toBeUndefined();
  });

  test("refuses a bad item and keeps none of the post", () => {
    const r = setAnnotations("orbit-scorer", declared, { items: [{ id: "1", updatedAt: AT, score: 0.9 }, { id: "2", updatedAt: "yesterday" }] });
    expect(r.ok).toBe(false);
    expect(annotate([row("1")])[0]!.annotations, "half a post was kept").toBeUndefined();
  });
});

describe("validateAnnotations", () => {
  const bad: [string, unknown][] = [
    ["not a list", { id: "1" }],
    ["an id that is not a string", [{ id: 1, updatedAt: AT }]],
    ["an empty id", [{ id: "", updatedAt: AT }]],
    ["no updatedAt", [{ id: "1" }]],
    ["a score that is NaN", [{ id: "1", updatedAt: AT, score: NaN }]],
    ["a rank that is text", [{ id: "1", updatedAt: AT, rank: "high" }]],
    ["a badge with no text", [{ id: "1", updatedAt: AT, badge: { tone: "danger" } }]],
    ["a badge over 24 characters", [{ id: "1", updatedAt: AT, badge: { text: "x".repeat(25) } }]],
    ["a tip over 200 characters", [{ id: "1", updatedAt: AT, tip: "x".repeat(201) }]],
  ];
  for (const [what, raw] of bad) test(`refuses ${what}`, () => expect(validateAnnotations(raw).ok).toBe(false));

  test("clamps a score to 0..1 and drops a tone it does not know", () => {
    const r = validateAnnotations([{ id: "1", updatedAt: AT, score: 4, badge: { text: "hot", tone: "purple" } }]);
    expect(r.ok && r.value[0]).toEqual({ id: "1", updatedAt: AT, score: 1, badge: { text: "hot", tone: undefined } });
  });
});

describe("the manifest", () => {
  test("inboxAnnotations must be a boolean", () => {
    expect(validateContributes({ inboxAnnotations: true })).toEqual({ ok: true, value: { inboxAnnotations: true } });
    expect(validateContributes({ inboxAnnotations: "yes" }).ok).toBe(false);
  });

  test("a secret field is accepted, and a default on it is not", () => {
    expect(validateFields([{ key: "apiKey", type: "secret", label: "Key" }]).ok).toBe(true);
    expect(validateFields([{ key: "apiKey", type: "secret", label: "Key", default: "tk-orbit" }]).ok).toBe(false);
  });
});

describe("redactSecrets", () => {
  const fields = [{ key: "apiKey", type: "secret" as const, label: "Key" }, { key: "mode", type: "string" as const, label: "Mode" }];
  test("nulls every secret, says which were set, and leaves the rest", () => {
    expect(redactSecrets(fields, { apiKey: "tk-orbit", mode: "live" })).toEqual({ values: { apiKey: null, mode: "live" }, set: ["apiKey"] });
    expect(redactSecrets(fields, { apiKey: "", mode: "live" })).toEqual({ values: { apiKey: null, mode: "live" }, set: [] });
    expect(redactSecrets(fields, { apiKey: null, mode: "live" }).set).toEqual([]);
  });
});

describe("what a badge may spell", () => {
  test("control, zero-width and bidi characters are stripped, and a badge left empty is refused", () => {
    const r = validateAnnotations([{ id: "1", updatedAt: AT, badge: { text: "ap‮prov​ed\u0007" }, tip: "a⁦b" }]);
    expect(r.ok && r.value[0]!.badge!.text).toBe("approved");
    expect(r.ok && r.value[0]!.tip).toBe("ab");
    expect(validateAnnotations([{ id: "1", updatedAt: AT, badge: { text: "​‮" } }]).ok).toBe(false);
  });
});
