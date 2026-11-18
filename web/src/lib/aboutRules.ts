/** The hint under "Look for a newer release by itself": it says what the switch does in the state it is in. */
export function autoCheckHint(on: boolean): string {
  return on
    ? "On: the release feed is asked shortly after the app starts and then every six hours."
    : "Off: the release feed is asked only when you press Check.";
}
