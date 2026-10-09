// How many assignees a board card carries, and so how many its faces can draw.
//
// One number for two places, because the cut is made where the card is READ
// (the server, off the cached boards; the browser, off a fresh lookup) and the
// "+N" is drawn where it is SHOWN. A reader that keeps three while the card
// draws five makes the "+N" unreachable: seven assignees read as "3 faces", not
// "5 faces and +2".

/** Assignee faces kept on a card; the rest read as "+N" and the tooltip names everyone. */
export const CARD_PEOPLE_MAX = 5;
