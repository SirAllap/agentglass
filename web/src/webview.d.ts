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
        /* `allowpopups` is deliberately NOT declared here. @types/react already
           declares it on this element as a boolean, its declaration wins the
           merge, and React's DOM renderer then DROPS a boolean for a custom
           element — see where it is set in BrowserPanel.tsx. */
        useragent?: string;
      };
    }
  }
}

export {};
