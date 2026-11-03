/*
 * `agx-md` is the markdown renderer's wrapper class, and a stylesheet that
 * gives the bare class a shell of its own draws every markdown body in the
 * app inside it. The merge dialog once did: a pull request Description came
 * out as a narrow, rounded, bordered box that clipped its own text. Only
 * PrPanel.tsx (MD_CSS) may select `.agx-md` itself; `.agx-md-<part>` and
 * `.agx-md *` descendants of the renderer are not the bare class.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const BARE = /(^|[^-\w])\.agx-md(?![-\w])/;

describe("the bare .agx-md class belongs to the markdown renderer", () => {
  test("no .css file selects it", async () => {
    const offenders: string[] = [];
    for await (const f of new Glob("src/**/*.css").scan({ cwd: `${import.meta.dir}/..` })) {
      const css = (await Bun.file(`${import.meta.dir}/../${f}`).text()).replace(/\/\*[\s\S]*?\*\//g, "");
      if (css.split("\n").some((l) => BARE.test(l.split("{")[0] ?? ""))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("the merge dialog's shell is not the renderer's class", async () => {
    const tsx = await Bun.file(`${import.meta.dir}/../src/components/MergeDialog.tsx`).text();
    expect(tsx).not.toMatch(/className="[^"]*\bagx-md\b(?!-)/);
  });
});
