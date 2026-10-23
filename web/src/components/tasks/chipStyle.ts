/*
 * What a pressed filter chip looks like, for every chip on a board: filled in
 * the accent's own colour with the panel's background for the text, the way the
 * app marks a pressed control everywhere else. A pressed chip that is only a
 * shade warmer than five outlined ones reads as "slightly warmer", not as "this
 * one is doing something" (reported as not being able to tell what was picked).
 */
export const ON_CHIP = {
  background: "var(--primary)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--primary)", color: "var(--on-primary)", fontWeight: 600,
} as const;
export const ON_CHIP_OK = {
  background: "var(--success)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--success)", color: "var(--bg)", fontWeight: 600,
} as const;
