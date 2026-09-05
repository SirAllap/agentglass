/*
 * The browser, in the bench.
 *
 * It IS the browser: the same component the Browser view mounts, with its
 * strip, its sidebar of bookmarks and history, its address bar and its
 * suggestions, its profiles and its cookies. Not a smaller one written again.
 *
 * A bare address bar over a `<webview>` was the first attempt and it deserved
 * what it got — "it gives me no suggestions and does not look like the browser".
 * Right: that is the ten percent of a browser which is easy to build, and every
 * part it leaves out is a part somebody uses to find the page they wanted.
 *
 * Two copies of one browser, and the split is deliberate:
 *
 *   shared     cookies, logins, profiles, history, bookmarks. It is the same
 *              browser and the same person.
 *   separate   which pages are open. Closing a tab here must not close it in
 *              the view, so the strip is saved under its own key — see the
 *              `scope` prop and browserSession's keyFor.
 *
 * Outside the desktop shell there is no `<webview>` at all — a plain browser tab
 * cannot embed another site, and an iframe would be refused by every host worth
 * opening. It says so rather than showing an empty rectangle.
 */
import { BrowserView } from "../BrowserPanel.tsx";
import { HAS_BROWSER, IS_DESKTOP } from "../../lib/desktop.ts";

export function BenchWeb({ active }: {
  /** Is this the tab on screen? The browser does real work per frame — guests,
   *  devtools rectangles, favicons — and does none of it while this is false. */
  active: boolean;
}) {
  if (!IS_DESKTOP || !HAS_BROWSER) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>
        <p>A page needs the desktop app.</p>
        <p className="text-[11px]" style={{ color: "var(--text4)" }}>
          In a browser tab this would be an iframe, and the sites worth opening here refuse to be framed.
        </p>
      </div>
    );
  }
  return (
    <div className="w-full h-full" style={{ background: "var(--bg)" }}>
      <BrowserView active={active} scope="bench" />
    </div>
  );
}
