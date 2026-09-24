/*
 * A client-side route change must not reload the page.
 *
 * Measured in the app: on a pushState router, a click on a nav link (by an
 * agent or a person) left the page at the new path but in a NEW document —
 * a marker set on `window` before the click was gone after it, and the
 * navigation timing entry read "navigate", not a same-document change. The
 * page's state was lost on every route, and every id `observe` had stamped
 * went with it, so an id taken before the click could not be used after it
 * even for a node the router never touched.
 *
 * The chain: the guest reports `did-navigate-in-page`, the panel stores the
 * new URL on the tab, the tab's URL is the webview's `src` prop, React writes
 * the attribute, and a webview navigates whenever its `src` attribute is
 * written. A same-document change became a load.
 *
 * After mount nothing needs React to move a guest — the address bar sets
 * `w.src` itself, the shelf and the driver call `loadURL` — so the prop is the
 * URL the guest was BORN with and stays that way for the element's life. A
 * tab that sleeps and wakes is a new element, and is born at its current URL.
 *
 * There is no renderer here, so the rule is asserted against the source.
 */
import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text();

/* The JSX element, not the word in a comment: comments here say `<webview>`. */
const TAG = SRC.search(/<webview\s+ref=/);

const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the guest's src is its birth URL", () => {
  test("the webview's src is not the tab's live url", () => {
    expect(TAG).toBeGreaterThan(-1);
    const tag = code(SRC.slice(TAG, SRC.indexOf("/>", TAG)));
    expect(tag).toContain("src={");
    expect(tag).not.toMatch(/src=\{\s*t\.url/);
  });

  test("it is frozen per mounted element, from the url the tab has at mount", () => {
    const at = SRC.indexOf("function BornAt(");
    expect(at, "no BornAt wrapper").toBeGreaterThan(-1);
    const body = code(SRC.slice(at, SRC.indexOf("\n}\n", at)));
    // useState's initial value is read once, at mount — later urls are ignored.
    expect(body).toMatch(/const \[\w+\] = useState\(/);
    expect(body).not.toContain("useEffect");
    const use = code(SRC.slice(SRC.indexOf("<BornAt url="), TAG));
    expect(use).toContain("t.url");
  });
});
