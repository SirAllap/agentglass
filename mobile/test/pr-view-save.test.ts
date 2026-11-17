/* What the phone's save-view sheet writes: the desk's PrView shape, valid for /prs/views. Invented repo and names. */
import { describe, expect, test } from "bun:test";
import { validateViews, type PrView } from "../../shared/prFilter.ts";
import { evalExempt } from "../../shared/prFilterEval.ts";
import { lanesFromRules, withNewView } from "../src/model/prViewSave.ts";
import { isBot } from "../src/model/prBoard.ts";

const ON = { drafts: true, bots: true };
const existing = (name: string, order: number): PrView => ({ id: `v${order}`, name, filter: lanesFromRules(ON), order });

describe("withNewView", () => {
  test("appends last with the next order, and the server validator accepts the list", () => {
    const r = withNewView([existing("Main", 0)], "  Release   train ", ON, "pvabc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view).toMatchObject({ id: "pvabc", name: "Release train", order: 1 });
    expect(validateViews(JSON.parse(JSON.stringify(r.list)))).toEqual(r.list);
  });
  test("refuses empty, long, taken (any case) and a full list", () => {
    const list = [existing("Main", 0)];
    expect(withNewView(list, "  ", ON, "x")).toEqual({ ok: false, reason: "empty" });
    expect(withNewView(list, "x".repeat(25), ON, "x")).toEqual({ ok: false, reason: "long" });
    expect(withNewView(list, "MAIN", ON, "x")).toEqual({ ok: false, reason: "taken" });
    const full = Array.from({ length: 12 }, (_, i) => existing(`V${i}`, i));
    expect(withNewView(full, "More", ON, "x")).toEqual({ ok: false, reason: "full" });
  });
});

describe("lanesFromRules", () => {
  test("switches off save no hide rules; on, they hide what the phone hides", () => {
    expect(lanesFromRules({ drafts: false, bots: false }).hide.children).toEqual([]);
    const rows = [
      { author: "ada", isDraft: false }, { author: "ada", isDraft: true },
      { author: "dep[bot]", isDraft: false }, { author: "bot", isDraft: false },
    ];
    const read = (p: (typeof rows)[number], k: string): string[] | null =>
      k === "is" ? [p.isDraft ? "draft" : "ready"] : k === "author" ? [p.author] : null;
    const kept = evalExempt(rows, lanesFromRules(ON), read, () => false).kept;
    expect(kept).toEqual([rows[0]!]);
    expect(rows.filter((p) => !isBot(p) && !p.isDraft)).toEqual(kept);
  });
});
