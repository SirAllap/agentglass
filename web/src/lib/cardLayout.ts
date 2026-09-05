// Where each field goes on the card.
//
// The chosen design is studies 01 + 03 + 10 from the mockups: ClickUp's own order,
// the long fields drawn ONCE, and the handful a board is triaged by in a band at the
// top, in the colours the workspace gave them.
//
// Three decisions, and all three are the kind that look obvious and are not:
//
//   WHAT GOES IN THE BAND. Not a hardcoded list of names — a workspace calls its
//   fields whatever it likes. The band takes coloured choices, because a colour is a
//   workspace saying "read this one at a glance", plus dates and quantities, which
//   are the other things a triage pass reads. Six at most: a band that wraps to two
//   rows is a header, not a band.
//
//   WHAT IS ALREADY IN THE BODY. A bug form writes "Steps to reproduce" into a custom
//   field AND into the description, word for word, and the card was drawing both. The
//   merge is a containment test on normalised text rather than a name match, because
//   the heading in the description is written by whoever filled the form and the field
//   is named by whoever built the list.
//
//   WHAT IS LEFT. Everything else is a row in the Fields section, in the workspace's
//   own order — which is the order somebody who uses the website knows.

import type { CardField } from "../../../shared/providers.ts";

/** How many fields the triage band will carry. Past six it wraps, and a band that
 *  wraps is just the grid it replaced. */
export const BAND_MAX = 6;

export interface CardLayout {
  /** The band across the top, in the order the workspace defines them. */
  band: CardField[];
  /** Long fields whose text is NOT already in the description — drawn under it, as
   *  sections of the body. */
  long: CardField[];
  /** Long fields the description already says, word for word. Counted, never drawn. */
  echoed: CardField[];
  /** Everything else: one row each, under Fields. */
  rows: CardField[];
}

/** Letters and digits only, lower case. Two texts that differ by a bullet, a line
 *  break or a stray double space are the same text to a reader, and the whole point
 *  here is to catch a field the description repeats. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Is this field's text already in the description?
 *
 * Containment rather than equality: the description usually carries the field's text
 * under a heading of its own, sometimes with the numbering the form added. Short
 * values are exempt — "No" appears in almost any paragraph, and folding a field away
 * because its one-word value happens to occur in the prose would hide a real answer.
 */
export const MIN_ECHO = 40;

export function echoes(body: string, field: CardField): boolean {
  if (field.kind !== "text") return false;
  const v = normalise(field.value);
  if (v.length < MIN_ECHO) return false;
  return normalise(body).includes(v);
}

/**
 * How long a field's name may be and still ride in the band.
 *
 * Measured on a real board: "Is this issue concerning a specific call/chat?" is a
 * field name, and in a band it wrapped its label onto a second line and stretched its
 * one-word value into a chip the width of the pane. A band is read at a glance, and a
 * label you have to READ is not glanceable — whatever its value is worth, it is worth
 * it in the rows below, where a long name has a column to itself.
 */
export const BAND_LABEL_MAX = 24;

/**
 * Which fields ride in the band.
 *
 * A coloured choice first — the workspace painted it, which is it saying this is read
 * at a glance — then dates and numbers, which are what a triage pass asks after "what
 * kind of thing is this". Never text, never a URL: neither reads at band size, and
 * both have somewhere better to be. And never a name too long to glance at, whatever
 * it holds.
 */
export function bandWorthy(f: CardField): boolean {
  if (labelOf(f.name).length > BAND_LABEL_MAX) return false;
  if (f.kind === "chip") return !!f.color;
  return f.kind === "date" || f.kind === "number";
}

/** The name without the parenthetical the workspace keeps in it — "Support Tool URL
 *  (MPL)" is one field, and the note in brackets is for whoever maintains the list.
 *  Length is judged on what the card will actually draw. */
export function labelOf(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

/**
 * Names a workspace gives to its own copy of the priority flag.
 *
 * ClickUp has a priority of its own — the flag, what its boards sort by — and a
 * list can ALSO carry a drop-down that somebody made for the same thing and
 * called "Urgency". Measured on a real board: one card showed `Normal` twice on
 * one screen, the flag and the drop-down, and neither said which was which.
 *
 * The duplicate is kept out of the BAND only. It stays in the rows, because the
 * two are genuinely different fields — one of them lives on the card and the
 * other on that list — and a record that quietly drops a field is a record you
 * cannot trust. Matched on the value as well as the name: a list whose Urgency
 * says something the flag does not is not a duplicate, it is a disagreement,
 * and hiding that would be the worst of the three outcomes.
 */
export const PRIORITY_ALIASES = ["priority", "urgency"];

export function repeatsPriority(f: CardField, priority: string | null | undefined): boolean {
  if (!priority || f.kind !== "chip") return false;
  if (!PRIORITY_ALIASES.includes(normalise(labelOf(f.name)))) return false;
  return normalise(f.value) === normalise(priority);
}

export function layoutCard(fields: readonly CardField[], description: string, priority?: string | null): CardLayout {
  const band: CardField[] = [];
  const long: CardField[] = [];
  const echoed: CardField[] = [];
  const rows: CardField[] = [];

  for (const f of fields) {
    if (!f.value) continue;
    if (f.kind === "text") {
      (echoes(description, f) ? echoed : long).push(f);
      continue;
    }
    /* A field can be in the band AND in the rows: the band is a summary, and the
       Fields section is the record. Leaving it out of the rows would mean the list of
       what this card has is only complete when the band happens to be empty. */
    if (band.length < BAND_MAX && bandWorthy(f) && !repeatsPriority(f, priority)) band.push(f);
    rows.push(f);
  }
  return { band, long, echoed, rows };
}
