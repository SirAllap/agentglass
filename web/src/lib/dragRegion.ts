// Electron computes the frameless window's drag region from element
// rectangles and ignores z-index: a floating layer painted ON TOP of the
// TopBar's `WebkitAppRegion: "drag"` strip is still, as far as the OS is
// concerned, sitting inside that rectangle. Pressing on it drags the whole
// window instead of the layer that is visibly there.
//
// Anything that can be positioned or anchored over the TopBar — the bench
// window, a corner search bar with no scope to anchor to — has to opt its own
// root out, the same way every clickable control inside the TopBar itself
// does (see TopBar.tsx).
import type { CSSProperties } from "react";

export const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;
