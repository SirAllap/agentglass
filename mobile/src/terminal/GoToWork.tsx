/*
 * Go to the work behind this pane (s50).
 *
 * One sheet between the four things that are the same piece of work: the
 * branch, its pull request, the card, and the windows on this machine. Every
 * row is a door, and the way back is the same door — the branch opens its pull
 * request, the pull request opens the window that is on its branch, and the
 * card opens the window whose branch carries its key.
 *
 * The decisions are in model/goToWork.ts. This draws them, and says why a row
 * has nowhere to go rather than leaving a dead one: "no window is on this
 * branch" is an answer, while a disabled row with no reason is a bug.
 *
 * The sheet wears the phone's palette (ui.tsx's `Sheet`), like every sheet that
 * rises over the terminal — the pane's colours are for the surface under it.
 */
import { Btn, Note, Sheet, SheetRow } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { Text, View } from "react-native";
import type { BranchPr } from "../model/goToWork.ts";

export interface WorkPane {
  paneId: string;
  name: string;
}

export function GoToWorkSheet({ open, onClose, title, branch, why, looking, pr, taskKey, prPane, keyPane, onOpenPr, onOpenPane, onWindows, onAllAbout }: {
  open: boolean;
  onClose: () => void;
  /** What this sheet is about: the window, its branch, its project. */
  title: string;
  branch: string | null;
  /** Why there is no branch to ask about — a detached head, or a computer that
   *  did not answer `/git/repo`. */
  why?: string | null;
  looking: boolean;
  pr: BranchPr | null;
  taskKey: string | null;
  prPane: WorkPane | null;
  keyPane: WorkPane | null;
  onOpenPr: (number: number) => void;
  onOpenPane: (paneId: string) => void;
  onWindows: () => void;
  /** The way back: everything about this pane (s03). */
  onAllAbout?: () => void;
}): React.ReactNode {
  const hit = pr?.hit ?? null;
  const branchSub = !branch
    ? looking ? "Asking the computer which branch this is…"
      : why || "The computer did not say which branch this checkout is on."
    : pr === null
      ? looking ? "Looking for its pull request…" : why || "Asking GitHub…"
      : hit
        ? `Its pull request is #${hit.number} · ${hit.title}`
        : pr.why;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Go to the work"
      subtitle={branch ? `${title}. Three jumps, and the way back.` : `${title}.`}
      footer={onAllAbout ? <Btn label="All about this pane" onPress={onAllAbout} style={{ flex: 1 }} /> : undefined}
    >
      {/* The branch is the fact the other rows are read from, so it is a row and
          not a heading: when it has a pull request, tapping it goes there. */}
      <SheetRow
        glyph="branch"
        leadColor={C.primary}
        label={branch || "No branch"}
        sub={branchSub}
        disabled={!hit}
        onPress={() => { if (hit) onOpenPr(hit.number); }}
        trail={hit ? (
          <View style={{
            height: 24, paddingHorizontal: SPACE.sm, justifyContent: "center", borderRadius: RADIUS.sm,
            backgroundColor: hit.state === "MERGED" ? tint(C.success, 0.14) : C.bg3,
          }}>
            <Text style={{ color: hit.state === "MERGED" ? C.success : C.text2, fontSize: T.eyebrow, fontWeight: "700" }}>
              {hit.isDraft ? "draft" : hit.state}
            </Text>
          </View>
        ) : undefined}
      />
      {hit ? (
        <SheetRow
          glyph="pr"
          label={`Pull request #${hit.number} → its pane`}
          sub={prPane ? `${prPane.name} is the window that ran the checks` : "No window is on this branch"}
          disabled={!prPane}
          onPress={() => { if (prPane) onOpenPane(prPane.paneId); }}
        />
      ) : null}
      {taskKey ? (
        <SheetRow
          glyph="list"
          label={`${taskKey} → its pane`}
          sub={keyPane ? `${keyPane.name} is carrying it` : "No window is carrying it"}
          disabled={!keyPane}
          onPress={() => { if (keyPane) onOpenPane(keyPane.paneId); }}
        />
      ) : null}
      <SheetRow
        glyph="window"
        label="Windows on the computer"
        sub="Every project's, grouped, with the ones waiting on you first"
        onPress={onWindows}
      />
      <Note>
        <Text style={{ fontWeight: "700" }}>The pane knows the PR and the card from the branch name.</Text>
        {" "}A checkout on no branch says so instead of guessing.
      </Note>
    </Sheet>
  );
}
