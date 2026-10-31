// The cloud / eye / lock family of the Add a GitHub repo page, drawn on the
// 24-unit grid of the mockup and sized from the house ICON ladder.
import { ICON } from "../lib/iconSize.ts";

const P = {
  cloud: <><path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.6a4.5 4.5 0 0 0 .5 8.9z" /><circle cx="12" cy="14" r="1.6" /></>,
  off: <><path d="M4 4l16 16" /><path d="M7.5 18.5h9.5M20.5 15a4 4 0 0 0-2.9-4.45A5.5 5.5 0 0 0 9 6.6M5.6 9.9A4.5 4.5 0 0 0 7.5 18.5" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2.5 2.5" /></>,
  q: <><circle cx="12" cy="12" r="8" /><path d="M9.7 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.7M12 16.6v.1" /></>,
  pr: <><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2v7.6M18 15.8V10a3 3 0 0 0-3-3h-4M13 4.5 10.5 7 13 9.5" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
  ext: <path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />,
  clone: <><path d="M12 4v10M8 10l4 4 4-4" /><path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" /></>,
};
export type RIconName = keyof typeof P;

export function RIcon({ name, size = ICON.sm }: { name: RIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size <= 12 ? 2.2 : 1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
  );
}
