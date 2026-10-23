import type { ComputerStatus } from "../model/computers.ts";
import type { Palette } from "../theme.ts";

/** Green only for a computer that answered; grey for one nobody has asked yet
 *  or that is not answering (the card under the header says which); red for
 *  one that took this phone off its list. */
export function statusColor(status: ComputerStatus, K: Palette): string {
  return status === "online" ? K.success : status === "removed" ? K.error : K.text4;
}
