/*
 * The verdict at the top of Troubleshooting.
 *
 * The screen was twenty rows with a dot each, and "is anything I need
 * missing" had to be counted off them.
 */
import { describe, expect, test } from "bun:test";
import { brokenHeading, depNeedsAttention, depSummary, depTone } from "../src/model/depLook.ts";

const dep = (status: "ok" | "missing" | "attention" | "unsupported", required = true) => ({ status, required });

describe("depSummary", () => {
  test("everything found is good", () => {
    expect(depSummary([dep("ok"), dep("ok", false)])).toMatchObject({ tone: "good", title: "2 of 2 tools found" });
  });
  test("every required tool present, only an optional one missing: calm, not a warning", () => {
    /* Measured against the screen: with every required tool installed and one
       optional formatter absent, this used to answer "warn" — an amber banner
       and a "Needs attention" heading over a machine with nothing wrong. */
    const s = depSummary([dep("ok"), dep("missing", false)]);
    expect(s.tone).toBe("mute");
    expect(s.sub).toContain("One optional tool is not installed");
  });
  test("a required one outranks it", () => {
    expect(depSummary([dep("attention"), dep("missing", false)]).tone).toBe("bad");
  });
  test("a tool this platform never uses counts as neither", () => {
    expect(depSummary([dep("ok"), dep("unsupported")])).toMatchObject({ tone: "good", title: "1 of 1 tools found" });
  });
});

describe("depTone — the row's own dot and text colour", () => {
  test("a required tool missing or needing a look stays loud", () => {
    expect(depTone(dep("missing"))).toBe("bad");
    expect(depTone(dep("attention"))).toBe("warn");
  });
  test("an optional tool missing or needing a look is calm, same as 'not used here'", () => {
    expect(depTone(dep("missing", false))).toBe("mute");
    expect(depTone(dep("attention", false))).toBe("mute");
  });
  test("installed is installed regardless of required", () => {
    expect(depTone(dep("ok"))).toBe("good");
    expect(depTone(dep("ok", false))).toBe("good");
  });
});

describe("brokenHeading — the group title over what needs attention", () => {
  test("nothing broken: no heading at all", () => {
    expect(brokenHeading([])).toBe(null);
  });
  test("a required tool broken: urgent wording", () => {
    expect(brokenHeading([{ required: true }, { required: false }])).toBe("Needs attention");
  });
  test("only optional tools broken: calm wording, not 'attention'", () => {
    expect(brokenHeading([{ required: false }])).toBe("Optional, not installed");
  });
});

// depNeedsAttention import kept alongside the others it is described with —
// unchanged by this fix, still true only for attention/missing.
describe("depNeedsAttention", () => {
  test("unsupported and ok are not attention", () => {
    expect(depNeedsAttention("unsupported")).toBe(false);
    expect(depNeedsAttention("ok")).toBe(false);
  });
});
