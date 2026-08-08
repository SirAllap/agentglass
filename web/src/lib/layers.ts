// What is on top of what, when two portals are on screen at once.
//
// Written down because guessing it cost a build. Portal sets its z-index on the
// CONTAINER it appends to <body>, so the numbers written on the elements inside
// only order them against their own siblings: a palette at 10001 inside a
// container at 9999 still renders underneath a viewer whose container is 10020.
// It looked right in the source and was wrong on the screen, which is the only
// place a stacking order exists.
//
// Two numbers in one file so the comparison that matters can be asserted rather
// than reasoned about — see layers.test.ts.

export const LAYER = {
  /**
   * A file, open over whatever you were looking at.
   *
   * Above the workspace and every panel in it, because it is raised FROM those
   * panels — a diff, a pull request, the file tree — and has to cover the list
   * it was opened from.
   */
  viewer: 10020,

  /**
   * The file palette.
   *
   * Above the viewer, and that is the whole design rather than a detail: the
   * palette stays open when it opens a document so the next result is a
   * keystroke and not another search. Put it below and opening a result buries
   * the list that produced it, which is the one behaviour this exists to avoid.
   */
  palette: 10040,

  /**
   * The Skills explorer.
   *
   * Above the workspace's own portal rather than merely after it: the rail
   * opens the catalog from inside the workspace, and at equal z the frame —
   * which mounts later — painted straight over it.
   */
  catalog: 10100,

  /**
   * Settings.
   *
   * Above the catalog, because the catalog can be open when you reach for the
   * gear and the sheet you just asked for has to be the one you get. It took
   * Portal's default (9999) and the catalog did not, so with the explorer open
   * the gear mounted Settings UNDERNEATH it: two scrims stacked, the catalog
   * still on top, and to the person clicking it the gear did nothing and the
   * app went black.
   *
   * The trade, stated because it is real: this puts Settings above the toast
   * band (10040–10060) that it used to sit under, so a note toast that arrives
   * while Settings is open is now behind it. That is the same place the catalog
   * has always been, so the two rail sheets at least behave alike; moving the
   * toasts above both is a bigger change than this one.
   */
  settings: 10120,

  /**
   * A menu opened from inside any of the above.
   *
   * Its own layer because it must escape its opener's box, not merely sit on
   * top of it: the palette clips its children (`overflow-hidden`, so the
   * rounded corners hold), so a dropdown rendered inside it is cut off at the
   * panel's edge — measured on screen with the checkout list, whose rows ran
   * off the left side and lost their names. A portal at this layer is drawn
   * against the viewport instead.
   *
   * TOP of the table, and that is load-bearing rather than tidy: Select took
   * Portal's default and worked only because its container is appended when it
   * opens, which is after everything already on screen. Give a sheet a number
   * and that stops being true — raising Settings without raising this would
   * have buried every dropdown in it, which is the same bug one floor up.
   */
  menu: 10200,
} as const;
