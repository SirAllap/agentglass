/*
 * The rules the bank's sheet holds as source, because there is no renderer.
 *
 * Each one is a defect that was on screen: a doubled "ago", a tab that moved
 * the tab and the account together, a console read that never fired for the tab
 * a person switched to, an estimate printed as the plan's own number.
 */
import { describe, expect, it } from "bun:test";

const topBar = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();
/** Comments stripped: a rule that only exists in a sentence is not a rule. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const src = code(topBar);

/** From `function name(` to the closing brace at column 0. */
function body(head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 2);
}

const panel = body("function PlanPanel(");
/** The tablist's own handler, from its `onKeyDown` to the buttons it governs. */
const tabHandler = panel.slice(panel.indexOf('role="tablist"'), panel.indexOf("{tabs.map("));

describe("the sheet's meta line", () => {
  it("does not add an 'ago' to a label that already carries one", () => {
    expect(panel).toContain("read ${readAge}");
    expect(panel).not.toContain('readAge === "just now"');
  });
});

describe("the sheet's tabs", () => {
  it("tell the footer where ←→ goes, because the tab row owns it while focused", () => {
    // Focus lands on the selected tab on open, and ←→ moved the tab there while
    // the legend printed "←→ account": the first keypress contradicted it.
    expect(tabHandler).toContain("onFocus={() => setInTabs(true)}");
    expect(tabHandler).toContain("setInTabs(false)");
    expect(panel).toContain("}, inTabs);");
    expect(panel).toContain("const [inTabs, setInTabs] = useState(!at.staged);");
  });

  it("switch the provider and stop the key before the account handler sees it", () => {
    expect(tabHandler).toContain("ev.stopPropagation()");
    // The order matters: preventDefault alone let ArrowRight move a chip too.
    expect(tabHandler.indexOf("ev.preventDefault()")).toBeLessThan(tabHandler.indexOf("ev.stopPropagation()"));
  });

  it("answer Home and End as the bar's own cells do", () => {
    expect(tabHandler).toContain('"Home"');
    expect(tabHandler).toContain('"End"');
  });

  it("take focus when the sheet opens, so the arrows are not dead on arrival", () => {
    expect(panel).toContain("tabEls.current.get(activeId)?.focus({ preventScroll: true })");
  });

  it("leave the keyboard where it was when an agent's proposal opened it", () => {
    // The person may be typing in the terminal; a mounted sheet that grabs the
    // selected tab turns their next character into a key for this dialog.
    expect(panel).toContain("useEffect(() => { if (!at.staged) tabEls.current.get(activeId)?.focus({ preventScroll: true }); }, []);");
  });

  it("carry the a11y pair the role promises: a panel, and a control per tab", () => {
    expect(panel).toContain('aria-controls="bank-sheet-body"');
    expect(panel).toContain('id="bank-sheet-body" role="tabpanel"');
  });

  it("label the panel and select the tab that is actually drawn", () => {
    // `tabId` can name a provider whose row has left the bar; the drawn row is
    // the strip's. Select, label and Escape follow the drawn one, or the panel
    // is announced with no label and no tab is selected.
    expect(panel).toContain("const activeId = tab.row.provider;");
    expect(panel).toContain("aria-selected={on}");
    expect(panel).toContain("const on = row.provider === activeId;");
    expect(panel).toContain("aria-labelledby={`bank-tab-${activeId}`}");
    expect(panel).toContain("onClick={() => onEscape(activeId)}");
  });

  it("swallow the arrows on a one-tab row instead of letting them move the account", () => {
    // With the bar filtered to one provider the arrows cannot move the tab; left
    // to bubble, `decideKey` maps → to the next chip and focus jumps there.
    expect(tabHandler).toContain("if (ids.length < 2) return;");
    expect(tabHandler.indexOf("ev.stopPropagation()")).toBeLessThan(tabHandler.indexOf("if (ids.length < 2) return;"));
  });
});

describe("the tab's own number", () => {
  it("is the same reading as the cell and the headline, spend included", () => {
    // A spend-only provider used to fall into the "none" shape here: a dash over
    // an empty track, beside a bar cell and a headline that both said $7.07.
    expect(panel).toContain("const badge = tabBadge(v);");
    expect(panel).toContain("{badge.track && (");
    expect(panel).toContain("{badge.text}");
    expect(panel).not.toContain('v.kind === "reading" ? v.percent : null');
  });
});

describe("an agent's proposal", () => {
  it("opens the sheet on the provider it names, so the card and its Switch button are drawn", () => {
    // The card lives inside the chips, and the chips follow the tab. Opened on
    // the busiest provider, a proposal whose provider is the only one with
    // plugin accounts drew no card at all and could not be confirmed.
    expect(src).toContain("stagedProvider(r.a.provider, (p) => barIds.current.has(p), liveProvider.current)");
    expect(src).toContain("barIds.current = new Set(chips.map((c) => c.row.provider));");
    expect(panel).toContain("useAccountPanel(tab.row, onClose, () => onEscape(activeId)");
  });
});

describe("the age beside the number", () => {
  it("belongs to the row drawn, not to another login of the same provider", () => {
    // A held core row ("12m", drawn in warning ink) used to date the fresh
    // second login's percent.
    expect(panel).toContain("const age = other ? null : tab.age;");
  });
});

describe("a cell has a width the fold can charge", () => {
  const chip = src.slice(src.indexOf("function PlanChip("), src.indexOf("export function TopBar"));
  it("caps the percent and the dollars at what 49px leaves them", () => {
    expect(chip.match(/maxWidth: "2\.05em"/g)?.length).toBe(2);
    expect(chip.match(/truncate/g)?.length).toBe(2);
  });
});

describe("the console read", () => {
  it("fires for the tab a person switches to, not only for the one it opened on", () => {
    const read = panel.slice(panel.indexOf("api.refreshOpenCodeUsage()"), panel.indexOf("api.refreshOpenCodeUsage()") + 120);
    expect(read).toContain("}, [activeId]);");
    expect(panel).toContain('if (activeId !== "opencode"');
  });

  it("does not re-post it for every repeat of a held arrow that lands on the tab", () => {
    // A held → walks Claude↔OpenCode at the keyboard's repeat rate: each entry
    // posted a refresh and a providers read, 30-60 requests a second.
    const at = panel.indexOf("api.refreshOpenCodeUsage()");
    const eff = panel.slice(panel.lastIndexOf("useEffect(() => {", at), panel.indexOf("}, [activeId]);"));
    expect(eff).toContain("if (shown?.calibration && now - shown.calibration.at < CONSOLE_REREAD_MS) return;");
  });
});

describe("the headline", () => {
  it("is the tested sentence, not a second copy of it", () => {
    expect(panel).toContain("sheetTail(worst, now)");
    expect(panel).not.toContain(" is used");
    // The mock's "Resets in 4h 12m": a bare duration read as half a phrase.
    expect(panel).not.toContain('replace(/^in /');
  });

  it("never lets its numbers freeze at the instant it opened", () => {
    // A sheet left open promised "resets in 1m" for as long as it stayed open.
    // One timer re-renders the sheet; nothing here asks the server again.
    expect(panel).toContain("const now = useMinuteNow().getTime();");
    expect(panel).not.toContain("cfgNow");
    const hook = body("function useMinuteNow(");
    expect(hook).toContain("setTimeout(");
    expect(hook).not.toContain("setInterval(");
    expect(hook).not.toContain("api.");
  });

  it("says estimate · this PC beside the number, not only inside the open fold", () => {
    expect(panel).toContain("{worstEstimated &&");
    expect(panel).toContain("estimate · this PC");
  });

  it("counts a spend with no windows as a reading, not as 'not reporting quota'", () => {
    expect(panel).toContain("shown?.available && shown.spend ?");
    expect(panel).toContain("spent over {shown.spend.window}");
  });
});

describe("a reading that is history", () => {
  it("gets no projection from today's clock", () => {
    expect(panel).toContain("const staleReading =");
    expect(panel).toContain("staleReading || estimated ? null : runsOut(");
    expect(panel).toContain("budget === null || staleReading ? null : paceVerdict(");
  });

  it("and no 'Resets now' under a window that ended days ago", () => {
    // The headline already dropped the clause; the row under it printed
    // "Resets now" from `resetLabel`, which answers "now" for any past reset.
    expect(panel).toContain("const reset = resetWhen(w, now);");
    expect(panel).not.toContain("const reset = resetLabel(");
  });

  it("paints an estimated verdict in no pace's ink, and says it is one", () => {
    // A green "14 points under" from an under-read of this PC is a measurement
    // the number cannot support: neutral ink, and the word in the sentence.
    expect(panel).toContain("const estimated = estimatedMinutes.has(w.minutes);");
    expect(panel).toContain('{verdict.text}{estimated ? " (estimate)" : ""}');
    expect(panel).toContain('color: estimated ? "var(--text3)" : verdict.tone === "over"');
  });

  it("puts the group's reset beside the group's own percent", () => {
    // The folded group shows the maximum percent; the reset beside it belonged
    // to the first window, so one model's clock sat under another's number.
    expect(panel).toContain("resetShort(tightestWindow.resetsAt)");
    expect(panel).not.toContain("resetShort(first.resetsAt)");
    expect(panel).toContain("const tightestWindow = g.windows.find((w) => w.usedPercent === top)!;");
  });

  it("and neither does a local estimate, which is not the plan's rate at all", () => {
    // The tag under the row says the number came from this PC; a "runs out
    // Friday" from the same arithmetic is exactly the sentence it forbids.
    expect(panel).toContain("staleReading || estimated ? null : runsOut(");
  });
});

describe("the sheet's one control for the whole list", () => {
  it("opens every fold the body can draw, and the same press shuts them", () => {
    expect(panel).toContain("const foldKeys = [...groups.map((g) => g.key), ...(shown?.available ? [\"days\"] : [])];");
    expect(panel).toContain("setFold(allOpen ? [] : foldKeys)");
  });

  it("reads the rows themselves, so opening them by hand turns it into Collapse all", () => {
    // A control with a state of its own said "Expand all" over a list already
    // open, because only the control could write its own memory.
    expect(panel).toContain("const allOpen = foldKeys.length > 0 && foldKeys.every((k) => openKeys.includes(k));");
    expect(panel).toContain('aria-label={allOpen ? "Collapse all" : "Expand all"}');
  });

  it("keeps rows open beside each other rather than one at a time", () => {
    expect(panel).toContain("const open = openKeys.includes(g.key);");
    expect(panel).toContain("onClick={() => toggleFold(g.key)}");
    expect(panel).not.toMatch(/\bopenKey\b/);
  });
});

describe("one per-day chart, and the calibration beside the number it qualifies", () => {
  const cal = body("function ConsoleCalibration(");

  it("draws the days once, in the fold every provider shares", () => {
    // A second chart of this PC's OpenCode tokens sat under the same sheet that
    // already drew the all-agents week, so the two disagreed at a glance.
    expect(panel).toContain('<DayStrip provider="anthropic" all />');
    expect(panel).not.toContain("Tokens by day");
    expect(panel).not.toContain("u.daily");
  });

  it("does not date the console read twice: the meta line already does", () => {
    // The line lived in the provider's own block, so it is the whole file that
    // has to be free of it, not only the panel's body.
    expect(src).not.toContain("Reading from ");
    expect(panel).toContain("const readLine =");
  });

  it("keeps the console's week against this PC's, the one place the under-read is said", () => {
    expect(cal).toContain("Console says the week is {consoleWeek}% used; this PC counted {localWeek}%.");
    expect(cal).toContain("const localWeek = week(u.windows);");
  });

  it("puts that sentence under the headline, not at the bottom of another fold", () => {
    expect(panel).toContain('{activeId === "opencode" && !other && shown && <ConsoleCalibration u={shown} />}');
    expect(panel.indexOf("<ConsoleCalibration u={shown} />")).toBeGreaterThan(panel.indexOf("sheetTail(worst, now)"));
    expect(panel.indexOf("<ConsoleCalibration u={shown} />")).toBeLessThan(panel.indexOf("{readLine}"));
  });

  it("keeps the console read reachable, as the button that asks for it", () => {
    expect(cal).toContain("api.refreshOpenCodeUsage(true)");
    expect(cal).toContain('{busy ? "Reading…" : "Read the console"}');
  });

  it("keeps per-model dollars, which no quota window carries", () => {
    expect(src).toContain("Per-model spend · last 30 days");
    expect(src).toContain("m.costUsd.toFixed(2)");
  });
});

describe("the bar around the sheet", () => {
  it("returns focus to the +n when the provider that opened it was folded away", () => {
    const anchor = src.slice(src.indexOf("const anchorFor"), src.indexOf("const [planAt"));
    expect(anchor).toContain("plusRef.current");
  });

  it("closes the sheet when the meters it came from stand down", () => {
    expect(src).toContain("if (metersHidden) setPlanAt(null)");
  });

  it("draws the loading skeleton at the same width the real cell uses", () => {
    expect(src).toContain("minWidth: BANK_CELL_PX");
    expect(src).not.toContain("minWidth: 49");
  });

  it("draws no bordered box, and no divider, when no provider has a chip", () => {
    // A machine with nothing installed, or every switch off in Settings: the
    // box used to stand as a 2px × 26px rounded speck between the project chip
    // and the finder, where the old bar drew nothing at all.
    expect(src).toContain("{(chips.length > 0 || !usageLoaded()) && (");
    expect(src).toMatch(/\{chips\.length > 0 && \(\s*<span className="shrink-0"/);
  });

  it("reads the tab badges on the sheet's own clock", () => {
    // A live Date.now() here flipped a badge to the local estimate while the
    // body under it still drew the console windows.
    expect(panel).toContain("chipView(row, now)");
  });

  it("names the +n for a screen reader, not only in a tooltip", () => {
    expect(src).toContain("aria-label={`${hiddenChips.length} more:");
  });

  it("says the cell opens a dialog", () => {
    expect(src).toContain('aria-haspopup="dialog"');
  });
});
