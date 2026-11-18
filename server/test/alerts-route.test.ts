// Notifications v2: every note shows in ONE place. The server's desktop popup
// is the fallback for when no page runs; a page that is open (focused or just
// visible) is answering pings, so it is `live` and shows the note itself.
// Pure tests on the decision, no sockets and no notify-send.
import { describe, expect, test } from "bun:test";
import { routeAlert } from "../src/alerts";

const base = { attached: 0, live: 0, redraw: false, desktop: true, desktopChannel: true, urgency: 2 as const };

describe("routeAlert: one place per note", () => {
  test("a focused or visible page is live, so the server never pops up", () => {
    expect(routeAlert({ ...base, attached: 1, live: 1 })).toEqual({ broadcast: true, popup: false });
  });

  test("no page runs: the popup fires and nothing is broadcast", () => {
    expect(routeAlert(base)).toEqual({ broadcast: false, popup: true });
  });

  test("a page attached but deaf (frozen) gets the frame and the popup still fires", () => {
    expect(routeAlert({ ...base, attached: 1, live: 0 })).toEqual({ broadcast: true, popup: true });
  });

  test("a redraw of a row is never a popup, even with no page", () => {
    expect(routeAlert({ ...base, redraw: true }).popup).toBe(false);
  });

  test("urgency 0 never pops up", () => {
    expect(routeAlert({ ...base, urgency: 0 }).popup).toBe(false);
  });

  test("desktop channel off or AGENTGLASS_NOTIFY unset: no popup", () => {
    expect(routeAlert({ ...base, desktopChannel: false }).popup).toBe(false);
    expect(routeAlert({ ...base, desktop: false }).popup).toBe(false);
  });
});
