/*
 * Repo insights: the texts and the copy outcome are decided in a pure module.
 */
import { describe, expect, it } from "bun:test";
import { changelogMarkdown, copyText, emptyChangelogText } from "../src/lib/insightsView.ts";
import type { Changelog } from "../../shared/types.ts";

const cl = (o: Partial<Changelog>): Changelog => ({ from: "", to: "HEAD", sections: [], ...o });

describe("emptyChangelogText", () => {
  it("names the tag right after a release", () => {
    expect(emptyChangelogText(cl({ from: "v1.2.0" }))).toBe("nothing since v1.2.0");
  });
  it("names both ends for a picked range", () => {
    expect(emptyChangelogText(cl({ from: "v1.0.0", to: "v1.1.0" }))).toBe("nothing between v1.0.0 and v1.1.0");
  });
  it("tells an empty repository from an empty range", () => {
    expect(emptyChangelogText(cl({ empty: true }))).toBe("no commits yet");
    expect(emptyChangelogText(cl({}))).toBe("no commits in range");
  });
});

describe("changelogMarkdown", () => {
  it("is empty without sections and carries the range with them", () => {
    expect(changelogMarkdown(null)).toBe("");
    const md = changelogMarkdown(cl({ from: "v1", sections: [{ title: "Fixes", entries: [{ kind: "fix", scope: "api", breaking: false, subject: "orbit ok", hash: "abc1234" }] }] }));
    expect(md).toContain("# Changelog v1..HEAD");
    expect(md).toContain("- **api:** orbit ok (abc1234)");
  });
});

describe("copyText", () => {
  it("reports both outcomes instead of swallowing the failure", async () => {
    expect(await copyText("x", async () => {})).toBe("copied");
    expect(await copyText("x", async () => { throw new Error("denied"); })).toBe("failed");
  });
});

describe("responsive classes in the Insights window", () => {
  // tailwind.config.js has an object screen (`tall`), and with that Tailwind 3.4
  // silently emits nothing for `min-[900px]:`: the window drew one column in the
  // compiled app while every unit test and the typecheck stayed green.
  it("uses media-query variants, which this build does generate, never min-[..]/max-[..]", async () => {
    for (const f of ["../src/components/InsightsModal.tsx", "../src/components/insights/ChangelogPane.tsx", "../src/components/insights/RangePicker.tsx", "../src/components/insights/DayBars.tsx", "../src/components/GitHeader.tsx"]) {
      const text = await Bun.file(new URL(f, import.meta.url)).text();
      expect(text).not.toMatch(/\b(min|max)-\[\d+px\]:/);
    }
    const modal = await Bun.file(new URL("../src/components/InsightsModal.tsx", import.meta.url)).text();
    expect(modal).toContain("[@media(min-width:900px)]:grid-cols-[minmax(0,1fr)_minmax(380px,32%)]");
  });
  it("keeps the copy button on one line in the 380 px column", async () => {
    const pane = await Bun.file(new URL("../src/components/insights/ChangelogPane.tsx", import.meta.url)).text();
    expect(pane).toContain('width: 172, whiteSpace: "nowrap", justifyContent: "center"');
  });
  it("keeps the change count on one line, so a short range label gives way instead", async () => {
    const pane = await Bun.file(new URL("../src/components/insights/ChangelogPane.tsx", import.meta.url)).text();
    expect(pane).toContain('className="ml-auto tabular-nums whitespace-nowrap shrink-0"');
  });
  it("lets the range pickers shrink so the From / to / count row never runs past the 380 px column", async () => {
    const picker = await Bun.file(new URL("../src/components/insights/RangePicker.tsx", import.meta.url)).text();
    expect(picker).toContain('className={label === "To" ? "inline-flex shrink-0" : "inline-flex min-w-0"}');
    expect(picker).toContain("max-w-[9.5rem] min-w-0");
  });
});
