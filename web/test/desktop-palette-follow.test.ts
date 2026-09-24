/**
 * Following the desktop's palette must not blink, and must reach the panes.
 *
 * Two things went wrong the first time, both visible on a real desktop within
 * minutes. The poll compared the answer object as well as its stamp, every
 * answer is a new object, so it repainted every three seconds — a repaint
 * rewrites the root's style, every terminal watches that and swaps its whole
 * theme, and the panes blinked on the clock. And the palette was held back
 * from this app's tmux, which paints its own background over the terminal, so
 * the chrome followed the desktop while every pane kept the last theme.
 */
import { test, expect } from "bun:test";

const SRC = await Bun.file(new URL("../src/lib/themes.ts", import.meta.url)).text();
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the poll repaints on a new stamp and nothing else", () => {
  expect(code).toMatch(/if \(changed\) \{/);
  expect(code).not.toMatch(/was !== desktop/);
});

test("the desktop palette is carried out to tmux, once per palette", () => {
  /* The branch that paints it honours `sync`… */
  expect(code).toMatch(/if \(sync\) syncTheme\(desktop as unknown as Theme\)/);
  /* …and the poll sends it only when the stamp differs from the last one sent,
     so a reload with the desktop unchanged repaints no running pane. */
  expect(code).toMatch(/const send = !!desktop && stamp !== sent;/);
  expect(code).toMatch(/localStorage\.setItem\(SYNCED_KEY, stamp\)/);
});

/*
 * A SEGMENT OF ITS OWN.
 *
 * For one release "System" silently meant the desktop's palette wherever there
 * was one, which made "System" mean two things. The desktop has its own mode
 * now, offered only where a desktop publishes a palette; "System" is the OS's
 * dark or light again, everywhere.
 */
test("system is the OS again, and the desktop has its own mode", () => {
  expect(code).toMatch(/if \(mode === "system"\) return systemIsDark\(\) \? SERIOUS_DARK : SERIOUS_LIGHT;/);
  expect(code).toMatch(/if \(mode === "desktop"\) return desktop \? DESKTOP_ID/);
  expect(code).toMatch(/if \(themeMode\(\) === "desktop"\) \{/);
});

test("whoever picked System while it meant the desktop is moved across once", () => {
  expect(code).toMatch(/if \(wasSystem && !moved\) \{\s*persistThemeMode\("desktop"\);/);
  expect(code).toMatch(/localStorage\.setItem\(MOVED_KEY, "1"\)/);
});

test("the desktop's mark is served from the machine, never shipped", async () => {
  const server = await Bun.file(new URL("../../server/src/desktopPalette.ts", import.meta.url)).text();
  expect(server).toMatch(/logo\.svg/);
  const picker = await Bun.file(new URL("../src/components/ThemePicker.tsx", import.meta.url)).text();
  expect(picker).toContain("/desktop/logo");
  /* And the word stands in when the mark cannot be had. */
  expect(picker).toMatch(/if \(!svg\) return <>\{name\}<\/>;/);
});

