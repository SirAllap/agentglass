/*
 * The Docker views' own pictures, drawn on a 16-unit grid like the approved
 * layout: the five sections, and the three that the cards and menus share. The
 * house set draws a box as a rectangle and volumes as a drawer, which read as
 * other things here, so these stay local to Docker.
 */
import { ICON } from "../../lib/iconSize.ts";
import type { ReactNode } from "react";

type P = { size?: number; className?: string };
const mk = (body: ReactNode) => ({ size = ICON.sm, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>{body}</svg>
);

export const CubeIcon = mk(<path d="M2.5 5.5L8 2.5l5.5 3v5L8 13.5l-5.5-3ZM2.5 5.5L8 8.5l5.5-3M8 8.5v5" />);
export const PictureIcon = mk(<><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.2" /><path d="M2.5 12l3.5-3.5 3 3 2-2 2.5 2.5" /></>);
export const CylinderIcon = mk(<><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></>);
export const NodesIcon = mk(<><circle cx="8" cy="3.5" r="1.7" /><circle cx="3.5" cy="12" r="1.7" /><circle cx="12.5" cy="12" r="1.7" /><path d="M8 5.2v2.3M8 7.5L4.3 10.4M8 7.5l3.7 2.9" /></>);
export const DriveIcon = mk(<><rect x="2" y="9" width="12" height="4" rx="1.5" /><path d="M2 9l1.8-5.5h8.4L14 9M11 11h.1" /></>);

/** Stacked layers: the build cache. */
export const LayersIcon = mk(<path d="M8 2.5 14 6 8 9.5 2 6ZM2 9.5l6 3.5 6-3.5" />);
export const UpIcon = mk(<path d="M8 13V4M4 7.5l4-4 4 4" />);

/** A circle with a bar: "nothing runs here" (Unused, Stopped). */
export const MinusCircleIcon = mk(<><circle cx="8" cy="8" r="5.8" /><path d="M5.5 8h5" /></>);
/** A broom: leftovers to sweep (Dangling, Safe to remove). */
export const BroomIcon = mk(<><path d="M9.8 2.5 6.6 8.6M4 9h6.2l1.3 4.5H2.7Z" /><path d="M5.6 11.2v2.2M8.2 11.2v2.2" /></>);
/** The bin: remove this thing. */
export const TrashIcon = mk(<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9" />);
