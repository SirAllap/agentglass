/*
 * One control height in a header or toolbar row: `CTRL_H.regular` (28), the
 * refresh button's own height. Round 2 of the audit found a header where the
 * icon-only refresh button was taller than its neighbours (`py-0.5`/`py-1`
 * text buttons with no `min-h`), and the same shape — a rounded button with
 * vertical padding standing in for a height — repeated across Git, Docker,
 * Tasks and the terminal's tmux strip.
 *
 * Source is read as text and matched against source, per this repo's rule
 * for a decision that belongs on the screen rather than at runtime: there is
 * no renderer here to mount the components and look. This is a regression
 * guard on the exact shapes the round-2 fixes replaced, not a general ban on
 * `py-0.5`/`py-1` (a row action, a menu item and a badge legitimately use
 * them outside a header).
 */
import { describe, expect, it } from "bun:test";

const ROOT = new URL("../src/components", import.meta.url).pathname;

async function read(path: string): Promise<string> {
  return Bun.file(ROOT + path).text();
}

describe("header/toolbar controls share the refresh button's height", () => {
  it("CTRL_H.regular is still the refresh button's own height", async () => {
    const chrome = await read("/workspace/Chrome.tsx");
    expect(chrome).toContain("CTRL_H = { compact: 22, regular: 28, large: 32 }");
    expect(chrome).toContain("width: CTRL_H.regular, height: CTRL_H.regular");
  });

  it("Tasks board header: Open/Sidebar/Modal no longer float at py-0.5", async () => {
    const src = await read("/TasksPanel.tsx");
    expect(src).not.toContain('className="text-[10.5px] px-2 py-0.5 rounded-lg"\n            style={{ border: edge(16), color: "var(--text2)" }}>\n            Open ↗');
    expect(src).not.toMatch(/\["side", "Sidebar"\][\s\S]{0,400}className="text-\[10\.5px\] px-2 py-0\.5"/);
  });

  it("Tasks card modal action bar: no bare py-1 buttons and refresh sits last", async () => {
    const src = await read("/TasksPanel.tsx");
    // Scoped to the action bar itself (Hand to Claude .. RefreshButton), not
    // the whole file — `px-2 py-1 rounded-lg` is a legitimate shape for an
    // unrelated row action elsewhere in this very large component.
    const start = src.indexOf("Hand to Claude ▾");
    const bar = src.slice(start, src.indexOf("RefreshButton onRefresh", start));
    expect(bar).not.toContain('px-2 py-1 rounded-lg"');
    // Refresh follows a `flex-1` spacer, so it is pushed to the bar's far end.
    expect(bar).toMatch(/<span className="flex-1" \/>\s*\{t\.url && \(\s*<a href=\{t\.url\}/);
  });

  it("Git header: the view tabs, insights and branch chip carry no bare py-1/py-0.5", async () => {
    const src = await read("/GitPanel.tsx");
    expect(src).not.toContain('font-medium px-3 py-1.5"');
    expect(src).not.toContain('className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap shrink-0 font-medium"');
    expect(src).not.toContain('className="px-2 py-0.5 rounded-md text-[11px] inline-flex items-center gap-1 min-w-0 max-w-[min(30vw,340px)] cursor-pointer"');
  });

  it("Docker header: filter, by-stack and Dense match the refresh button's height", async () => {
    const src = await read("/DockerPanel.tsx");
    expect(src).not.toContain('className="text-[10px] px-2 py-0.5 rounded-lg outline-none w-[120px]"');
    expect(src).not.toContain('className="text-[10px] px-2 py-0.5 rounded-lg min-h-[20px]"');
  });

  it("Terminal tmux strip: the active window tab carries a box, not colour alone", async () => {
    const src = await read("/TerminalPanel.tsx");
    expect(src).toContain("chipTone(w.id === activeWindow)");
  });
});
