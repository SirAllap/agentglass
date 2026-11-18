/*
 * The chip of a card that moved since it was last looked at: "1 new comment", "2 new", or the move ("moved to Done"), the
 * way a pull request card says "1 new remark". Reads its own answer from the store the board fills, so a tile or a row
 * renders it with nothing but the card's id. The tooltip says what, since when and, where the comments are loaded, from whom.
 */
import { useChangeOf } from "../../../lib/jiraChangedStore.ts";
import { chipWords, sinceLooked } from "../../../lib/jiraChanged.ts";
import { tipAttr } from "../../../lib/tip.ts";

export function ChangedMark({ id }: { id: string }) {
  const ch = useChangeOf(id);
  if (!ch) return null;
  const said = !!ch.count;
  return (
    <span className="agx-jchg" data-testid="jira-changed" data-kind={said ? "comments" : undefined}
      data-tip={tipAttr({ name: sinceLooked(ch), text: "Opening the card marks it read." })}>
      {said ? <b>{chipWords(ch)}</b> : <><b>new</b><span className="r">{ch.reason}</span></>}
    </span>
  );
}
