/*
 * The "No server" banner must be reachable from inside the desktop app.
 *
 * It was not, and the way it was unreachable is the interesting part. The
 * banner's effect began `if (!SERVER_GUESSED) return`, and api.ts computes
 * `SERVER_GUESSED` as "no VITE_CW_SERVER, no DESKTOP_API, not served by the
 * API". The packaged shell always sets `DESKTOP_API` — that is how the renderer
 * learns which port the sidecar took — so `SERVER_GUESSED` is false in the
 * desktop, always, and the banner returned before it had looked at anything.
 *
 * The comment above it said the desktop "has probed the port since #126". True,
 * and not the same claim: the shell probes to PICK a port and then spawns a
 * sidecar into it. When that spawn failed — a missing binary, a port it could
 * not bind, a crash on the first line — the origin was configured, looked
 * verified, and was empty. The app came up, every panel failed the way a panel
 * fails when there is nothing to show, and the only thing on screen that
 * disagreed was a CLOSED pill in the header.
 *
 * So the shell reports its own failures now (electron/main.js) and they are
 * rendered here. This file renders the component for real rather than reading
 * its source, because "the banner exists in the file" was true the whole time
 * the bug was shipped — what was false is that anything could reach it.
 */
import { describe, expect, test, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Failure = {
  reason: "missing" | "spawn" | "exited" | "timeout";
  what: string; where?: string; fix: string; detail?: string; port?: number;
};

/** What the shell hands over, per failure kind. Held here as data so the
 *  assertions below are about what a person reads, not about a shape. */
const FAILURES: Record<string, Failure> = {
  missing: {
    reason: "missing",
    what: "The server program is not where the app expects it.",
    where: "/opt/agentglass/resources/agentglass-server",
    fix: "This install is incomplete — reinstall the app.",
    port: 4000,
  },
  exited: {
    reason: "exited",
    what: "The server started and stopped again (exit 1).",
    fix: "Something else may be holding port 4000, or the server hit an error on startup.",
    detail: "error: EADDRINUSE 0.0.0.0:4000",
    port: 4000,
  },
  timeout: {
    reason: "timeout",
    what: "The server did not answer on port 4000 within 12 seconds.",
    fix: "It may still be starting. If this stays, restart the app.",
    port: 4000,
  },
};

/*
 * api.ts is mocked rather than imported. Not for speed: it reads
 * `window.agentglass`, `location.href` and localStorage while its module body
 * runs, and a module body only runs once per process — so a test that set those
 * up could ask about exactly one scenario and every later case would silently
 * get the first one's answers. The mock is the seam the component actually
 * depends on, which is the only part being asserted here.
 */
let shellFailure: Failure | null = null;
let identity: "ours" | "foreign" | "down" = "ours";
/*
 * The stub DELEGATES to the real module and overrides only the seams below.
 *
 * `mock.module` is process-wide and permanent, and this call runs at module
 * scope, so the seven exports listed here used to BE `src/lib/api.ts` for every
 * suite loaded after this one. Measured on ubuntu-latest, where this file ran
 * hundredth and `gate-store.test.ts` hundred-and-eleventh: the store's poll
 * reaches `api`, this stub exported no `api` at all, and the poll never
 * happened — which the suite reported as "nobody polled after a subscriber
 * arrived", a sentence about the store and not about this file. It was green
 * here only because this machine loads the files in another order.
 *
 * The real module is pulled in through a specifier `mock.module` does not
 * match, so the override is additive. The globals go first because `api.ts`
 * reads `location.href`/`location.hostname` and localStorage in its module
 * body — the very reason a stub was reached for in the first place.
 */
(globalThis as any).location ??= { hostname: "127.0.0.1", origin: "http://127.0.0.1:4000", href: "http://127.0.0.1:4000/" };
(globalThis as any).localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
const API_PATH = new URL("../src/lib/api.ts", import.meta.url).pathname;
const realApiModule = await import(`${API_PATH}?unmocked`);
mock.module(API_PATH, () => ({
  ...realApiModule,
  IS_DEMO: false,
  SERVER: "http://127.0.0.1:4000",
  // False, exactly as the packaged desktop computes it. The whole bug lived in
  // this being the first thing the component looked at.
  SERVER_GUESSED: false,
  probeServer: async () => identity,
  sidecarFailure: () => shellFailure,
  onSidecarFailure: () => () => {},
}));

const render = async (failure: Failure | null) => {
  shellFailure = failure;
  const { default: ServerBanner } = await import("../src/components/ServerBanner.tsx");
  return renderToStaticMarkup(React.createElement(ServerBanner));
};

describe("the desktop shell's own report", () => {
  test("a missing server program says so, names it, and says what to do", async () => {
    const html = await render(FAILURES.missing!);
    expect(html).toContain("No server");
    expect(html).toContain("The server program is not where the app expects it.");
    // The path, because "reinstall" is unactionable advice when the person
    // reading it is the one who built the package.
    expect(html).toContain("/opt/agentglass/resources/agentglass-server");
    expect(html).toContain("reinstall the app");
    // An alert, not decoration: this is the one thing on the screen that
    // disagrees with everything else, and a screen reader has to reach it.
    expect(html).toContain('role="alert"');
  });

  test("a server that would not start carries its own last words", async () => {
    const html = await render(FAILURES.exited!);
    expect(html).toContain("The server started and stopped again (exit 1).");
    expect(html).toContain("holding port 4000");
    // The detail is the only text in the banner that names a cause we could not
    // classify. Dropping it was the difference between "it did not start" and
    // "it did not start because something else has your port".
    expect(html).toContain("EADDRINUSE");
  });

  test("a slow start is not dressed up as a broken install", async () => {
    const html = await render(FAILURES.timeout!);
    expect(html).toContain("did not answer on port 4000");
    expect(html).toContain("may still be starting");
    // The softer colour. `missing` cannot fix itself and this might, and the
    // two must not look the same at a glance.
    expect(html).toContain("--warning");
    expect(html).not.toContain("--error");
  });

  test("a broken install is the loud one", async () => {
    expect(await render(FAILURES.missing!)).toContain("--error");
  });

  test("and with a server up it renders nothing at all", async () => {
    // The case that matters most, because it is every other second of the app's
    // life. `SERVER_GUESSED` is false here — the desktop — so the probe path is
    // off too, and there must be no bar.
    expect(await render(null)).toBe("");
  });
});

/*
 * WHAT THIS FILE CANNOT RENDER, said out loud rather than faked.
 *
 * `renderToStaticMarkup` runs no effects. Both remaining behaviours live in
 * effects — the origin probe answering `foreign`/`down`, and a shell failure
 * that ARRIVES rather than being there at load, which is every ordinary one
 * since the window deliberately does not wait for the server. A render test
 * written against them would assert the empty string and pass whatever the
 * component did, which is worse than no test: an earlier draft of this file did
 * exactly that and read as coverage.
 *
 * So they are pinned at the source, which is honest about what it is checking.
 */
describe("what a static render cannot see", () => {
  test("the shell's report is subscribed to, not only read once", async () => {
    const src = await Bun.file(new URL("../src/components/ServerBanner.tsx", import.meta.url).pathname).text();
    expect(src).toContain("onSidecarFailure(setShell)");
    // Seeded from the shell as well, for a window that opened after the give-up
    // — a reload, or a second window — which has already missed the event.
    expect(src).toContain("useState<SidecarFailure | null>(() => sidecarFailure())");
  });

  test("the run-from-source probe survived being built around", async () => {
    const src = await Bun.file(new URL("../src/components/ServerBanner.tsx", import.meta.url).pathname).text();
    // The guess-check is the ONLY thing `SERVER_GUESSED` may gate. It used to
    // gate the whole component, which is how the desktop lost its banner.
    expect(src).toMatch(/if \(!SERVER_GUESSED \|\| IS_DEMO\) return;/);
    expect(src).toContain("Wrong server");
    expect(src).toContain("VITE_CW_SERVER");
    // The desktop branch is decided BEFORE `identity`, so a shell that knows
    // there is no server is not overruled by a probe that has not answered yet.
    expect(src.indexOf("if (shell) return")).toBeLessThan(src.indexOf('if (identity === "ours") return null'));
  });
});
