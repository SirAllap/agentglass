/*
 * The terminal's WebView, as a real iframe.
 *
 * This started as a box that said "the terminal runs in a WebView, which this
 * harness has not got" — and that box is why the terminal shipped broken
 * twice. The QA sweep walked the screen, saw the tab strip and the key bar,
 * reported "ok", and never executed a line of xterm, the bridge or the socket.
 * The one screen most likely to be wrong was the one screen never run.
 *
 * An iframe runs the same document the phone gets, byte for byte: xterm is
 * bundled into it and the browser is a browser. So the harness now exercises
 * the whole path — the engine, the bridge, the WebSocket to `/terminal/pty`,
 * the tmux attach — and a screenshot shows what is actually on the pane.
 *
 * Two seams have to be bridged, and both are small:
 *
 *   `window.ReactNativeWebView.postMessage` — the page calls it; here it is
 *   defined as a `parent.postMessage`, injected ahead of the document.
 *
 *   `injectJavaScript` — React Native's escape hatch for pushing into the
 *   page. The same thing, through `contentWindow.eval`.
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type WebViewMessageEvent = { nativeEvent: { data: string } };

interface Props {
  source: { html: string };
  onMessage?: (event: WebViewMessageEvent) => void;
  /* Everything else the real WebView takes is accepted and ignored. Declared
     as optional unknowns rather than an index signature, which would widen
     `source` and `onMessage` to unknown along with them. */
  style?: unknown;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  cacheEnabled?: boolean;
  originWhitelist?: string[];
  setSupportMultipleWindows?: boolean;
  allowsLinkPreview?: boolean;
  overScrollMode?: string;
  androidLayerType?: string;
  keyboardDisplayRequiresUserAction?: boolean;
  hideKeyboardAccessoryView?: boolean;
}

/** Defined before the document's own script, because the terminal posts its
 *  `ready` frame during that script. */
const BRIDGE = `<script>
  window.ReactNativeWebView = {
    postMessage: function (message) { parent.postMessage({ __agx: message }, "*"); }
  };
</script>`;

export const WebView = forwardRef<{ injectJavaScript: (js: string) => void }, Props>(
  function WebView({ source, onMessage }, ref) {
    const frame = useRef<HTMLIFrameElement | null>(null);

    useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string): void => {
        try {
          (frame.current?.contentWindow as unknown as { eval: (s: string) => void })?.eval(js);
        } catch {
          // The page is mid-navigation. React Native drops these too.
        }
      },
    }), []);

    useEffect(() => {
      const listen = (event: MessageEvent): void => {
        const data = event.data as { __agx?: string } | undefined;
        if (typeof data?.__agx === "string") onMessage?.({ nativeEvent: { data: data.__agx } });
      };
      window.addEventListener("message", listen);
      return () => window.removeEventListener("message", listen);
    }, [onMessage]);

    // `createElement` rather than JSX: react-native-web's type surface has no
    // iframe, and this file only ever runs under it.
    return createElement("iframe", {
      ref: frame,
      srcDoc: source.html.replace("<body>", `<body>${BRIDGE}`),
      style: { flex: 1, border: "none", width: "100%", height: "100%", background: "#0d1117" },
      title: "terminal",
    });
  },
);

export default WebView;
