/*
 * Two controls that had drifted off the house family, and one of them lied.
 *
 * The PR board's Open / Closed / All was a hand-rolled pill group at 10px, and
 * picking Closed fed the closed list into the board: merged pull requests
 * landed in "Blocked" with "Open to re-run" under a heading that counted them
 * as open. The board is a triage of open work, so the state axis is the
 * house `Segmented` now, and anything but Open leaves the board for the table.
 *
 * The dashboard's Alerts panel painted each card in its own severity (an amber
 * body and outline for an insight), a card treatment none of its sibling
 * panels share. The colour is on a left rail now, as on the Sessions cards.
 *
 * Source is read as text: there is no renderer here to mount and look.
 */
import { describe, expect, it } from "bun:test";

const pr = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
const alerts = await Bun.file(new URL("../src/components/Alerts.tsx", import.meta.url).pathname).text();

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("PR board state axis", () => {
  it("is the house Segmented", () => {
    expect(code(pr)).toMatch(/<Segmented value=\{stateSel\}/);
  });

  it("leaves the board for the table on Closed or All", () => {
    const at = pr.indexOf("<Segmented value={stateSel}");
    const call = pr.slice(at, pr.indexOf("/>", at));
    expect(call).toContain('if (s !== "open") setBoard(false)');
  });

  it("puts the board back on Open when Board is picked", () => {
    expect(pr).toContain('setInboxOn(false); setMetricsOn(false); setStateSel("open"); setBoard(true);');
  });
});

describe("Alerts panel cards", () => {
  it("carry severity on a rail, not as a tinted body", () => {
    const body = code(alerts);
    // No card background mixed from a severity colour.
    expect(body).not.toMatch(/background: `color-mix\(in srgb, \$\{(l\.color|color)\}/);
    expect(body).not.toContain('background: "color-mix(in srgb, var(--warning) 14%');
    expect((body.match(/<Rail color=/g) ?? []).length).toBe(3);
  });
});
