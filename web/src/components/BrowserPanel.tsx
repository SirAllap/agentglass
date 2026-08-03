// A page, inside the app.
//
// This is an Electron `<webview>` rather than the newer `WebContentsView`, and
// the reason is this app's layout rather than a preference. A WebContentsView is
// a main-process rectangle positioned in *window* coordinates: it floats over
// the DOM. The workspace is a rounded overlay whose views all stay mounted and
// merely flip visibility, so a WebContentsView would sit on top of the frame,
// cover every menu and dialog the app opens, and need its bounds recomputed by
// hand on every resize and every view switch. A `<webview>` is a DOM element —
// it lays out, clips and hides like anything else, and the existing model just
// works.
//
// The guest is given nothing: no preload, no Node, its own session. That is
// enforced in the main process (`guardWebviews`), not here — attributes in this
// markup are a request, and `will-attach-webview` is the answer.
import { useCallback, useEffect, useRef, useState } from "react";
import { BROWSER_PARTITION, HAS_BROWSER } from "../lib/desktop.ts";
import { displayUrl, normalizeNavigationUrl } from "../lib/browserUrl.ts";
import { BLANK, homePage, searchEngine } from "../lib/browserPrefs.ts";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";

/** Electron's `<webview>` is not in React's JSX catalogue, and its methods are
 *  not on HTMLElement. Narrowed to the handful actually called here rather than
 *  cast to `any`, so a typo is still a type error. */
type WebviewEl = HTMLElement & {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
};

/** The workspace hands every view an `active`, and this one has no use for it:
 *  there is nothing to poll, and a page must keep running while you are looking
 *  at something else — that is the point of the views staying mounted. */
export function BrowserView(_props: { active: boolean }) {
  const ref = useRef<WebviewEl | null>(null);
  // Only the *first* page is read at mount. Everything else asks
  // `browserPrefs` at the moment it needs an answer, because this view is
  // mounted once for the life of the app: a home page cached here would ignore
  // every change made in settings until a restart.
  const [firstPage] = useState(homePage);

  // What the page is at, and what is in the bar, are two different facts: while
  // you are typing, the page has not moved. `typed` being null means "not
  // editing", so navigation is free to update the display.
  const [url, setUrl] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [failed, setFailed] = useState<string | null>(null);

  // Wired imperatively because these are custom DOM events on an element React
  // does not know, so there is no `onDidNavigate` prop to hand it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      try {
        setUrl(el.getURL());
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
      } catch { /* the guest is not attached yet */ }
    };
    const onStart = () => { setLoading(true); setFailed(null); };
    const onStop = () => { setLoading(false); sync(); };
    // Only the main frame's failure is the page's failure: a blocked tracker in
    // a subframe is not a broken page, and reporting it as one would put an
    // error over a page that rendered perfectly well.
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; isMainFrame?: boolean; errorCode?: number };
      if (d.isMainFrame === false) return;
      // -3 is ABORTED, which is what a navigation you interrupted looks like.
      if (d.errorCode === -3) return;
      setLoading(false);
      setFailed(d.errorDescription || "The page could not be loaded");
    };
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
    el.addEventListener("did-fail-load", onFail);
    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-navigate", sync);
      el.removeEventListener("did-navigate-in-page", sync);
      el.removeEventListener("did-fail-load", onFail);
    };
  }, []);

  const go = useCallback((raw: string) => {
    // `about:blank` is not a URL the address-bar parser will hand back — it is
    // not http(s) — but it is exactly where Home goes when the home page has
    // been left empty, so it is passed straight through.
    const next = raw === BLANK ? BLANK : normalizeNavigationUrl(raw, searchEngine());
    if (!next || !ref.current) return;
    setTyped(null);
    setFailed(null);
    ref.current.src = next;
  }, []);

  if (!HAS_BROWSER) return null;

  const shown = typed ?? (url ? displayUrl(url) : "");
  const btn = {
    color: "var(--text2)",
    border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <span className={viewTitleClass} style={{ color: "var(--text)" }}>Browser</span>
        {loading && <span className="text-[10px]" style={{ color: "var(--text3)" }}>loading…</span>}
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0"
        style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
        <button onClick={() => ref.current?.goBack()} disabled={!nav.back} title="Back"
          className="agx-btn text-[11px] px-2 py-1 rounded disabled:opacity-30" style={btn}>‹</button>
        <button onClick={() => ref.current?.goForward()} disabled={!nav.forward} title="Forward"
          className="agx-btn text-[11px] px-2 py-1 rounded disabled:opacity-30" style={btn}>›</button>
        <button onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          title={loading ? "Stop" : "Reload"}
          className="agx-btn text-[11px] px-2 py-1 rounded" style={btn}>{loading ? "✕" : "⟳"}</button>
        <button onClick={() => go(homePage())} title="Home"
          className="agx-btn text-[11px] px-2 py-1 rounded" style={btn}>⌂</button>

        <input
          value={shown}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => { setTyped(url || ""); e.currentTarget.select(); }}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); go(typed ?? ""); e.currentTarget.blur(); }
            // Escape puts back what the page actually is, rather than leaving a
            // half-typed address sitting over a page you never left.
            if (e.key === "Escape") { e.preventDefault(); setTyped(null); e.currentTarget.blur(); }
          }}
          spellCheck={false}
          placeholder="Address, or something to search for"
          className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded outline-none bg-transparent"
          style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
        />
      </div>

      {failed && (
        <div className="px-3 py-2 text-[11px] shrink-0" style={{ color: "var(--warning)" }}>
          {failed}
        </div>
      )}

      {/* `partition` comes from the shell rather than being written here: the
          main process refuses to attach a guest on any other, so inventing the
          string in two places is one typo away from a pane that never loads.

          Nothing hides this: the workspace already does, with `visibility`
          rather than `display:none`, and for a reason that applies here word
          for word. A `display:none` ancestor measures 0x0, which is how the
          terminal used to come back reflowed to a single column — and a guest
          resized to nothing is the same bug wearing a different hat. */}
      <div className="flex-1 min-h-0">
        <webview
          ref={ref as unknown as React.Ref<HTMLElement>}
          src={firstPage}
          partition={BROWSER_PARTITION}
          allowpopups={undefined}
          style={{ width: "100%", height: "100%", background: "var(--bg)" }}
        />
      </div>
    </div>
  );
}
