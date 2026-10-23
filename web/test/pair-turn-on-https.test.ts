// There is no renderer in this project, so the wiring of "Turn on HTTPS" is
// asserted against the source: the button calls the server, the answer's
// status goes back to the page, and the manual command is still there folded.
import { expect, test } from "bun:test";

const pair = await Bun.file(new URL("../src/components/PairPanel.tsx", import.meta.url)).text();
const pane = await Bun.file(new URL("../src/components/RemoteAccessPane.tsx", import.meta.url)).text();

test("the button calls the server and hands the fresh status upward", () => {
  expect(pair).toContain("Turn on HTTPS");
  expect(pair).toContain("api.remoteServe()");
  expect(pair).toContain("onStatus?.(r.status)");
});

test("the manual command stays, folded", () => {
  expect(pair).toMatch(/<details>[\s\S]*tailscale serve --bg \$\{port\}/);
});

test("the pane offers the button only with Tailscale and no HTTPS route, and asks for fresh probes only then", () => {
  expect(pane).toContain("canTurnOnHttps={!!st.tailnet?.installed && !st.addresses.some((a) => a.secure)}");
  expect(pane).toContain("api.remoteStatus(wantFresh.current)");
  expect(pane).toContain("newlySecure(lastAddrs.current");
});
