/*
 * What a tap on a chip row means, once one of them is already on.
 *
 * The first option is the row's "all of them" ("All repos", "Any checkout"),
 * so tapping the selected chip again selects it. Until this existed, a
 * repository chip could be selected and never un-selected from the row: the
 * only way back was the first chip, which a thumb scrolling to the far end
 * cannot see.
 */
export function chipPick<T>(options: readonly { id: T }[], value: T, tapped: T): T {
  const all = options[0]?.id;
  return tapped === value && all !== undefined ? all : tapped;
}
