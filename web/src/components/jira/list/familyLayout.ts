/**
 * What a sub-task row shows at a given row width (px). The key and the status dot never go. When the row is narrow the
 * status text yields first (the dot stays, its name moves to the tooltip); the title is always shown and shrinks with an
 * ellipsis in whatever room is left.
 */
export type KidLayout = { statusText: boolean };

/** Below this the key, a minimal title and the dot fill the row; the status text is dropped. */
export const KID_STATUS_TEXT_MIN = 260;

export function kidLayout(width: number): KidLayout {
  return { statusText: !(width > 0 && width < KID_STATUS_TEXT_MIN) };
}
