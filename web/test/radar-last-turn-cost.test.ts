/**
 * The last turn's cost sits beside the context meter on the Radar's session
 * card, in both layouts. The lifetime cost only climbs; what a person decides
 * on before the next message is what the newest turn cost, and it belongs
 * next to the number that explains it — the context that turn re-read.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/Radar.tsx", import.meta.url)).text();
const dossier = src.slice(src.indexOf("function Dossier("), src.indexOf("function Row("));

describe("the Radar card shows the last turn's cost next to the context meter", () => {
  test("beside the dial: a row right under the context row", () => {
    const ctx = dossier.indexOf('<Row k="context"');
    const last = dossier.indexOf('<Row k="last turn" v={fmtUsd(a.turnCost)} />');
    expect(ctx).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(ctx);
    expect(dossier.slice(ctx, last).split("\n").length, "not the next row").toBe(2);
  });

  test("stacked under the dial: on the meter's own line", () => {
    const line = dossier.split("\n").find((l) => l.includes("{meter}<span"));
    expect(line).toBeDefined();
    expect(line!).toContain("fmtUsd(a.turnCost)");
  });

  test("its tooltip does not promise one model request", () => {
    // Without usage in the payload an event's cost is the transcript's total
    // since the previous recorded event, so when no hook fired between two
    // requests it covers both. The tooltip said "one call".
    const line = dossier.split("\n").find((l) => l.includes("{meter}<span"))!;
    const title = line.slice(line.indexOf('title="') + 7, line.indexOf('">last '));
    expect(title).not.toContain("one call");
    expect(title).toContain("more than one");
  });
});
