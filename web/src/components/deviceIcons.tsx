import { ICON } from "../lib/iconSize.ts";
import type { DeviceKind } from "../lib/remoteView.ts";
import { PhoneIcon } from "./settingsNavIcons.tsx";

/** Glyphs for the Remote & devices page: a device by kind, this machine, and the small marks in its chips and tables. */
const svg = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
type P = { size?: number };

export function TabletIcon({ size = ICON.md }: P) {
  return <svg {...svg} width={size} height={size} aria-hidden><rect x="4" y="2.5" width="16" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>;
}
export function LaptopIcon({ size = ICON.md }: P) {
  return <svg {...svg} width={size} height={size} aria-hidden><rect x="4.5" y="5" width="15" height="10.5" rx="1.5" /><path d="M2.5 19h19" /></svg>;
}
export function DesktopIcon({ size = ICON.md }: P) {
  return <svg {...svg} width={size} height={size} aria-hidden><rect x="3" y="4" width="18" height="12.5" rx="1.8" /><path d="M9 20.5h6M12 16.5v4" /></svg>;
}
export function DeviceIcon({ kind, size = ICON.md }: P & { kind: DeviceKind }) {
  return kind === "tablet" ? <TabletIcon size={size} /> : kind === "laptop" ? <LaptopIcon size={size} /> : <PhoneIcon size={size} />;
}

const small = { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export function CheckMark({ size = ICON.xs }: P) {
  return <svg {...small} strokeWidth={1.6} width={size} height={size} aria-hidden><path d="M2.5 6.3 5 8.6l4.6-5.2" /></svg>;
}
export function DashMark({ size = ICON.xs }: P) {
  return <svg {...small} width={size} height={size} aria-hidden><path d="M3.5 6h5" /></svg>;
}
export function LockMark({ open, size = ICON.xs }: P & { open?: boolean }) {
  return <svg {...small} strokeWidth={1.3} width={size} height={size} aria-hidden><rect x="2.5" y="5.2" width="7" height="5" rx="1.2" /><path d={open ? "M4 5.2V3.9a2 2 0 0 1 3.8-.8" : "M4 5.2V3.9a2 2 0 0 1 4 0v1.3"} /></svg>;
}
export function WarnMark({ size = ICON.xs }: P) {
  return <svg {...small} strokeWidth={1.3} width={size} height={size} aria-hidden><path d="M6 1.8 10.8 10H1.2z" /><path d="M6 5v2.2M6 8.6v.1" /></svg>;
}
