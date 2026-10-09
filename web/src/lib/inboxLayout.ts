/**
 * Where the Inbox keeps its shelves and filters.
 *
 * Beside the list, a 190 px column, until the panel is too narrow to give the
 * list what a row needs; then above it, as one strip that scrolls sideways.
 * Measured at 640 px, a row beside the rail had ~100 px left for its title
 * after the tick, the icon, the chip, the age and the three verbs, and the
 * title wrapped one letter to a line.
 *
 * The panel's own width decides, not the window's: the same window shows this
 * panel at half or at full width, so a viewport media query would answer a
 * different question.
 */
export const INBOX_RAIL_WIDTH = 190;

/** The least a row can read in with its tick, icon and a title that is still a line of words (matches the title's `min-w-[220px]` in Inbox.tsx plus the row's own chrome). */
const ROW_MIN = 370;

/** Below this the list would be narrower than ROW_MIN. */
export const INBOX_RAIL_FOLDS_BELOW = INBOX_RAIL_WIDTH + ROW_MIN;

/** True when the rail should sit above the list. A width of 0 is "not measured yet" and keeps the usual place, so the first paint never flashes the strip. */
export const railFolds = (panelWidth: number): boolean => panelWidth > 0 && panelWidth < INBOX_RAIL_FOLDS_BELOW;
