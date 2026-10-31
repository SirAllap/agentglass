/*
 * The glyphs of the Flight plan screen, as the approved design draws them: 24-box
 * strokes in the same hand as the workspace rail's. Kept here rather than in
 * workspace/icons.tsx because nothing else uses a scale or a seal.
 */
import { ICON } from "../../lib/iconSize.ts";
import { FlightPlanIcon } from "../workspace/icons.tsx";

type P = { size?: number };
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const mk = (sw: number, d: React.ReactNode) => ({ size = ICON.sm }: P) => <svg {...base} strokeWidth={sw} width={size} height={size}>{d}</svg>;

export const PlaneIcon = FlightPlanIcon;
export const PlusIcon = mk(2.4, <path d="M12 5v14M5 12h14" />);
export const DocIcon = mk(2, <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h4" /></>);
export const FrameIcon = mk(2, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 13h5" /></>);
export const EyeIcon = mk(2, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const TickIcon = mk(2.6, <path d="M5 12l5 5L20 7" />);
export const WrenchIcon = mk(2, <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z" />);
export const ScaleIcon = mk(2, <path d="M12 4v16M6 20h12M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0zM19 8l-2.5 6a3 3 0 0 0 5 0z" />);
export const AskIcon = mk(2, <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>);
export const CrossIcon = mk(2.4, <path d="M6 6l12 12M18 6L6 18" />);
export const DashIcon = mk(2.4, <path d="M7 12h10" />);
export const SealIcon = mk(2, <><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 22 12s-1 2-3 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2" /></>);
export const GearIcon = mk(2, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>);
export const SearchIcon = mk(2, <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
export const FolderIcon = mk(2, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const ArrowLeftIcon = mk(2.2, <path d="M19 12H5M11 6l-6 6 6 6" />);
export const PauseIcon = mk(2.2, <><path d="M9 5v14M15 5v14" /></>);
export const CoinIcon = mk(2, <><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2c-.4-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.8s1 1.6 2.5 2 2.5.8 2.5 2-1.1 1.9-2.5 1.9c-1.2 0-2.2-.5-2.6-1.4M12 6.5V8m0 8v1.5" /></>);
export const ClockIcon = mk(2, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const StopIcon = mk(2.2, <rect x="6" y="6" width="12" height="12" rx="2" />);
export const LockIcon = mk(2, <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const ShieldIcon = mk(2, <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" />);
export const MergeIcon = mk(2, <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 8v8M8 6c6 0 8 2 8 6" /></>);
export const BellIcon = mk(2, <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" />);
export const PenIcon = mk(2, <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" />);
