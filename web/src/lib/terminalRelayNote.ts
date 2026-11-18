/*
 * What the terminal relay's row says under its switch.
 *
 * The switch is a stored choice the server reads once, when it starts, so
 * what is saved and what is running can differ until the app is started
 * again; and AGENTGLASS_TERMRELAY=1 or =0 in the server's environment decides
 * instead of the stored choice. A switch that says "on" over a relay that is
 * not running, with no word about it, is how the relay went off unnoticed
 * after an app restart: the row says which of the three it is.
 */
export function terminalRelayNote(stored: boolean, running: boolean | null, held: "1" | "0" | null | undefined): string | null {
  if (held === "1" || held === "0") {
    return `AGENTGLASS_TERMRELAY=${held} is set where the app was started, and it decides: the relay is ${held === "1" ? "on" : "off"} whatever this switch says.`;
  }
  if (running === null) return null;
  if (stored && !running) return "Saved. The relay starts the next time the app starts.";
  if (!stored && running) return "Saved. The relay is running now and stops the next time the app starts.";
  return stored ? "The relay is running." : null;
}
