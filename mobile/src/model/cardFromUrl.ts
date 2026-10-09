/*
 * The card a task link points at, when the phone can draw it itself.
 *
 * `/card/[id]` asks `/clickup/task?id=`, which takes a plain task id or, on a
 * workspace with custom ids switched on, the human one (ORBIT-1042). What a
 * link's id is comes from `shared/taskref.ts`, the table the desk reads too, so
 * `/t/<id>` and the team-qualified `/t/<team>/<custom-id>` are both a card here
 * and a new address shape is added in one place.
 */
import { itemFromUrl } from "../../../shared/taskref.ts";

export function cardIdFromUrl(url: string | null | undefined): string | null {
  if (!/^https:\/\//i.test(url ?? "")) return null;
  const item = itemFromUrl(url);
  return item?.tracker === "clickup" ? item.id : null;
}
