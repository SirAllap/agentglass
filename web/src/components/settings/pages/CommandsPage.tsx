import { SettingsPage } from "../shell/SettingsPage.tsx";
import { RecipesPane } from "../../RecipesPane.tsx";
import { ReviewPromptsPane } from "../../ReviewPromptsPane.tsx";
import { SavedRepliesPane } from "../../SavedRepliesPane.tsx";
import type { PageCtx } from "./ctx.ts";

/** Library > Commands & replies: the run-time lists keep their own panes; each sits in its own section. */
export function CommandsSettingsPage({ c }: { c: PageCtx }) {
  return (
    <SettingsPage
      title="Commands & replies"
      purpose="Keep the commands, review prompts and replies you use again and again."
      sections={[
        { id: "commands", title: "Commands", kind: "normal", body: <RecipesPane open={c.open} /> },
        { id: "review", title: "Review sessions", kind: "normal", body: <ReviewPromptsPane open={c.open} /> },
        { id: "replies", title: "Saved replies", kind: "normal", body: <SavedRepliesPane open={c.open} /> },
      ]}
    />
  );
}
