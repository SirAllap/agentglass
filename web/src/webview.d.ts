// Electron's `<webview>` is a custom element, so it is not in React's catalogue
// of intrinsic elements and TypeScript rejects it on sight.
//
// Declared with the handful of attributes this app actually sets rather than a
// permissive index signature: `partition` and `src` are the two the main
// process validates in `will-attach-webview`, and a typo in either is a pane
// that silently never attaches. Being a compile error instead is worth the
// eleven lines.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        /** Present only to be explicitly undefined: a guest that may open
         *  windows is one this app has nowhere to put. */
        allowpopups?: undefined;
        useragent?: string;
      };
    }
  }
}

export {};
