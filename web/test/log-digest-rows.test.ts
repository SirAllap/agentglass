/*
 * The Server log rows in Settings > About. The section broke words in half
 * ("to t|he network") because the message used `break-all`, showed the grouping
 * key ("bound to <n>.<n>.<n>.<n>") instead of a real line, and drew the log's own
 * emoji beside the app's marker. No DOM harness in web/, so these are source
 * assertions; the example and the emoji stripping are tested on the server.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { minutesAgo } from "../src/lib/format.ts";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const from = src.indexOf("function LogRow(");
const section = src.slice(from, src.indexOf("function AboutPane("));
const code = section.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

describe("log digest rows", () => {
  test("found the section", () => expect(from).toBeGreaterThan(0));
  test("wraps at words; a long token breaks only as a last resort", () => {
    expect(code).not.toContain("break-all");
    expect(code).toContain('overflowWrap: "anywhere"');
  });
  test("shows the concrete example, never the grouping key", () => {
    expect(code).toContain("g.example");
    expect(code).not.toMatch(/text=\{[^}]*\.sig\b/);
  });
  test("severity is a badge, and the count and time are the row's description", () => {
    expect(code).toContain('<StatusBadge tone={level === "error" ? "err" : "warn"}>');
    expect(code).toContain("hint={`${count} · ${when}`}");
  });
  test("the message is shown whole, never folded to two lines behind a click", () => {
    expect(code).not.toContain("WebkitLineClamp");
    expect(code).not.toContain("aria-expanded");
    expect(code).not.toContain("useClipped");
  });
});

describe("Server log rows: time and clamping", () => {
  test("says just now under a minute, not 0 min ago", () => {
    const now = 1_800_000_000_000;
    expect(minutesAgo(now, now)).toBe("just now");
    expect(minutesAgo(now - 25_000, now)).toBe("just now");
    expect(minutesAgo(now + 5_000, now)).toBe("just now"); // a clock a little ahead
    expect(minutesAgo(now - 60_000, now)).toBe("1 min ago");
    expect(minutesAgo(now - 59 * 60_000, now)).toBe("59 min ago");
    expect(minutesAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });

  test("a row is a plain SettingRow: no button, no clamp, nothing to measure", () => {
    const start = src.indexOf("function LogRow(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("<SettingRow");
    expect(body).not.toMatch(/useClipped|clickable|cursor-pointer|"button"/);
  });
});
