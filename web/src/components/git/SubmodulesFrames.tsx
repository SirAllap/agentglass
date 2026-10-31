/*
 * What the Submodules tab shows: the inspector of the picked submodule and the
 * empty frame. The server reports a status word, not a commit distance, so the
 * inspector says what the word means rather than drawing a gap it cannot measure.
 */
import type { GitSubmodule } from "../../../../shared/types.ts";
import { BoxIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Aside, Fact, InspectorHead, NothingPicked, StateFrame } from "./HistoryFrames.tsx";
import { wash } from "./ui.tsx";

const MEANING: Record<GitSubmodule["status"], string> = {
  clean: "The folder is at the commit the repository pins.",
  modified: "The folder has edits, or sits on a different commit than the repository pins.",
  uninitialized: "Not set up. The folder is empty until it is updated.",
  conflict: "The folder is in conflict with what the repository pins.",
};

export function SubmoduleInspector({ sub }: { sub?: GitSubmodule }) {
  if (!sub) return <NothingPicked what="a submodule" />;
  const tone = sub.status === "clean" ? "--success" : sub.status === "uninitialized" ? "--warning" : "--error";
  return (
    <Aside>
      <InspectorHead icon={<BoxIcon size={ICON.md} />} tone={tone} title={sub.path}
        sub={<>pinned <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{sub.sha.slice(0, 7)}</span></>} />
      <div className="text-[11.5px] leading-relaxed px-3 py-2 rounded-lg" style={{ color: "var(--text2)", background: wash(tone, 10) }}>{MEANING[sub.status]}</div>
      <div className="flex flex-col gap-1.5">
        <Fact wide mono k="URL" v={sub.url} />
        <Fact wide k="Branch" v={sub.branch || "none set"} />
        <Fact wide k="Local edits" v={sub.status === "modified" ? "yes" : sub.status === "uninitialized" ? "not set up" : "none"} />
      </div>
    </Aside>
  );
}

export function NoSubmodulesFrame() {
  return <StateFrame title="No submodules" text="A submodule is another repository pinned inside this one, at one commit. Add one with Add a submodule." />;
}
