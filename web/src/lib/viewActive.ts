// Is the view this component sits in the one on screen?
//
// Every visited view stays mounted and the others are only `visibility: hidden`
// (see Workspace.tsx). A clock deep inside one cannot tell: `document.hidden` is
// false, and an IntersectionObserver still reports a `visibility: hidden` box as
// intersecting. Threading `active` through every layer down to a card or a
// canvas is how the clocks below it were missed, so the view box provides it
// once and any component reads it. Outside any view (a modal, a test) it is true,
// which is what those clocks did before.
import { createContext, useContext } from "react";

export const ViewActive = createContext(true);

/** True unless the view holding this component is hidden behind another one. */
export function useViewActive(): boolean {
  return useContext(ViewActive);
}
