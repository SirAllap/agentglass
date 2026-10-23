// The finder's own small icon set, drawn in the same 14-unit stroke style as
// glyphIcons.tsx. Strata's places and file types are lucide shapes (house, trash,
// network, file-text, download, music, image, video, hard-drive, braces, code,
// info, archive, audio-lines); the repo has no icon library and takes none for
// this, so they are drawn here. Colour comes from `tone`, never from the shape.
import { FileIcon, FolderIcon, HomeIcon, ClockIcon } from "./glyphIcons.tsx";
import { ICON } from "./iconSize.ts";
import type { Glyph, Tone } from "./finderGlyphs.ts";

type P = { size?: number; className?: string };
const svg = (size: number, className?: string) => ({
  width: size, height: size, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.4,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className,
});

export const TrashIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2.4 3.8h9.2M5.4 3.8V2.3h3.2v1.5M3.6 3.8l.5 7.9h5.8l.5-7.9M5.8 6v3.7M8.2 6v3.7" /></svg>);
export const NetworkIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M5.2 1.8h3.6v2.8H5.2zM1.6 9.4h3.6v2.8H1.6zM8.8 9.4h3.6v2.8H8.8zM7 4.6v2.2M3.4 9.4V6.8h7.2v2.6" /></svg>);
export const DocumentIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M3.4 1.6h5.1l2.6 2.6v8.2H3.4zM8.4 1.7v2.6h2.6M5.1 7.2h3.8M5.1 9.5h3.8" /></svg>);
export const DownloadIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M7 1.8v6.8M4.4 6.2L7 8.8l2.6-2.6M2.4 11.8h9.2" /></svg>);
export const MusicIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M5.2 10.4V3.2l6-1.3v7.3" /><circle cx="3.9" cy="10.6" r="1.4" /><circle cx="9.9" cy="9.4" r="1.4" /></svg>);
export const PictureIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 2.4h10v9.2H2zM2 10l3-3 2.4 2.4L9 7.8l3 3" /><circle cx="5" cy="5.2" r=".9" /></svg>);
export const ClapperIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 5.6h10v6.2H2zM2 5.6l.8-2.8 9.4 1.6-.4 1.2M5.2 3.2l-.7 2.3M8.2 3.7l-.7 2" /></svg>);
export const DriveIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 8h10v3.4H2zM2 8l1.4-4.6h7.2L12 8M9.6 9.7h.01M7.6 9.7h.01" /></svg>);
export const BracesIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M5.4 2.2c-1.4 0-1.8.8-1.8 1.8v1.3c0 .9-.6 1.7-1.6 1.7 1 0 1.6.8 1.6 1.7V10c0 1 .4 1.8 1.8 1.8M8.6 2.2c1.4 0 1.8.8 1.8 1.8v1.3c0 .9.6 1.7 1.6 1.7-1 0-1.6.8-1.6 1.7V10c0 1-.4 1.8-1.8 1.8" /></svg>);
export const AnglesIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M5 4L2 7l3 3M9 4l3 3-3 3" /></svg>);
export const InfoMarkIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><circle cx="7" cy="7" r="5.2" /><path d="M7 6.4v3.3M7 4.4h.01" /></svg>);
export const ArchiveBoxIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 2.6h10v2.6H2zM3 5.2v6.2h8V5.2M5.8 7.6h2.4" /></svg>);
export const WaveformIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 6.4v1.2M4.6 4v6M7 2v10M9.4 4.4v5.2M12 6v2" /></svg>);
export const SlidersIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 4h5.2M10 4h2M2 10h2M7 10h5M7.2 2.4v3.2M4.4 8.4v3.2" /></svg>);
export const PanelLeftIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2 2.6h10v8.8H2zM5.4 2.6v8.8" /></svg>);
export const ArrowLeftIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M11.6 7H2.8M6.4 3.4L2.8 7l3.6 3.6" /></svg>);
export const ArrowRightIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2.4 7h8.8M7.6 3.4L11.2 7l-3.6 3.6" /></svg>);
export const ArrowUpIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M7 11.6V2.8M3.4 6.4L7 2.8l3.6 3.6" /></svg>);
export const ArrowDownIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M7 2.4v8.8M3.4 7.6L7 11.2l3.6-3.6" /></svg>);
export const ExternalIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M8 2h4v4M12 2L6.4 7.6M10.4 8.4V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1h2.6" /></svg>);
export const SheetIcon = ({ size = ICON.sm, className }: P) => (
  <svg {...svg(size, className)}><path d="M2.4 2.4h9.2v9.2H2.4zM2.4 5.6h9.2M2.4 8.6h9.2M6 5.6v6" /></svg>);

/** The colour a tone is drawn in: theme inks, so light and dark both hold. */
export const TONE_INK: Record<Tone, string> = {
  plain: "var(--text2)", amber: "var(--warning-ink)", teal: "var(--info-ink)", green: "var(--success-ink)",
  violet: "var(--primary-ink)", red: "var(--error-ink)", dim: "var(--text3)",
};

export function GlyphIcon({ glyph, size = ICON.sm }: { glyph: Glyph; size?: number }) {
  switch (glyph) {
    case "folder": return <FolderIcon size={size} />;
    case "braces": return <BracesIcon size={size} />;
    case "readme": return <InfoMarkIcon size={size} />;
    case "markdown": return <DocumentIcon size={size} />;
    case "code": return <AnglesIcon size={size} />;
    case "image": return <PictureIcon size={size} />;
    case "video": return <ClapperIcon size={size} />;
    case "audio": return <WaveformIcon size={size} />;
    case "archive": case "package": case "disc": return <ArchiveBoxIcon size={size} />;
    case "sheet": return <SheetIcon size={size} />;
    default: return <FileIcon size={size} />;
  }
}

/** The sidebar's places, by the same names Strata gives them. */
export function PlaceIcon({ id, size = ICON.sm }: { id: string; size?: number }) {
  switch (id) {
    case "home": return <HomeIcon size={size} />;
    case "trash": return <TrashIcon size={size} />;
    case "network": return <NetworkIcon size={size} />;
    case "recent": return <ClockIcon size={size} />;
    case "Documents": return <DocumentIcon size={size} />;
    case "Downloads": return <DownloadIcon size={size} />;
    case "Music": return <MusicIcon size={size} />;
    case "Pictures": return <PictureIcon size={size} />;
    case "Videos": return <ClapperIcon size={size} />;
    case "device": return <DriveIcon size={size} />;
    default: return <FolderIcon size={size} />;
  }
}
