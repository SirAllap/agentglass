// Widths to check a page at.
//
// Not a device emulator: no user-agent games, no touch events, no pixel ratio.
// It narrows the frame the guest lives in, which is the half that actually
// catches things — a layout that breaks at 390px breaks because of the width,
// and pretending to be an iPhone as well would be claiming a fidelity this
// does not have.

export interface Viewport {
  name: string;
  /** Null is "as wide as the pane". */
  width: number | null;
}

/**
 * The four that earn their place.
 *
 * 390 is the modern small phone (iPhone 14/15), 768 the tablet portrait
 * breakpoint nearly every framework ships, and 1280 the laptop most people are
 * actually on. A longer list is a menu you scroll rather than a set of
 * decisions.
 */
export const VIEWPORTS: Viewport[] = [
  { name: "Full width", width: null },
  { name: "Phone", width: 390 },
  { name: "Tablet", width: 768 },
  { name: "Laptop", width: 1280 },
];

/** The one to show after a restart, or the full width when the stored name no
 *  longer names anything — a list that shrinks must not strand somebody at a
 *  width they cannot get back from. */
export function viewportByName(name: string | null | undefined): Viewport {
  return VIEWPORTS.find((v) => v.name === name) ?? VIEWPORTS[0]!;
}
