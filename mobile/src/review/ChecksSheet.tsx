/*
 * "Checks on #184" — the run at a glance (mock 34).
 *
 * The Checks TAB of a pull request opens this, not the job list: the question
 * a tab answers is "is it green, and what is still running", and that is three
 * rows of squares. The job list is a screen of its own because a log is
 * hundreds of lines somebody scrolls (app/pr/checks.tsx says why), and every
 * row here is the door to it.
 *
 * One square is one check, in the four inks the pull request's own card uses.
 * The grouping and the words are model/checkJobs.ts's; this is the drawing.
 */
import type { PrCheck } from "../../../shared/types.ts";
import { Pressable, Text, View } from "react-native";
import { runGroups } from "../model/checkJobs.ts";
import { Btn, Note, Sheet } from "../ui.tsx";
import { C, MONO, SPACE, T, tint } from "../theme.ts";

/** The four inks a square is drawn in, plus the ring a required check wears. */
const SQUARE = {
  pass: () => C.success,
  fail: () => C.error,
  run: () => C.warning,
  skip: () => "transparent",
} as const;

export function ChecksSheet({ open, onClose, number, checks, mayWrite, busy, said, onRerun, onOpenRun }: {
  open: boolean;
  onClose: () => void;
  number: number;
  checks: readonly PrCheck[];
  mayWrite: boolean;
  busy?: boolean;
  /** What the last re-run press answered, when it has something to say. */
  said?: string | null;
  onRerun: () => void;
  /** The job list and its logs, one row down. */
  onOpenRun: (job?: string) => void;
}): React.ReactNode {
  const now = Date.now();
  const groups = runGroups(checks, 40);
  const running = checks.filter((c) => c.state === "pending").length;
  const required = checks.some((c) => c.required);
  /** How long the run has been going, or took: the oldest start to the newest
   *  end, which is the number GitHub puts on the run itself. */
  const starts = checks.map((c) => (c.startedAt ? Date.parse(c.startedAt) : NaN)).filter(Number.isFinite);
  const ends = checks.map((c) => (c.completedAt ? Date.parse(c.completedAt) : NaN)).filter(Number.isFinite);
  const span = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return s % 60 && m < 60 ? `${m} min ${s % 60} s` : `${m} min`;
  };
  const from = starts.length ? Math.min(...starts) : NaN;
  const to = running ? now : ends.length ? Math.max(...ends) : NaN;
  const elapsed = Number.isFinite(from) && Number.isFinite(to) ? span(to - from) : "";
  const subtitle = `${groups.length} job${groups.length === 1 ? "" : "s"} · ${checks.length} check${checks.length === 1 ? "" : "s"}`
    + `${running ? ` · ${running} running` : ""}${elapsed ? ` · the run is ${elapsed} in.` : "."}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Checks on #${number}`}
      subtitle={subtitle}
      tall
      footer={
        <Btn
          label="Run the checks again"
          busy={busy}
          disabled={!mayWrite || !!busy}
          onPress={onRerun}
        />
      }
    >
      {groups.length ? (
        <View style={{ paddingTop: SPACE.xs }}>
          {groups.map((group) => (
            <Pressable
              key={group.name}
              accessibilityRole="button"
              accessibilityLabel={`${group.name}: ${group.count} checks, ${group.word}. Opens the job list.`}
              onPress={() => onOpenRun(group.name)}
              style={({ pressed }) => ({
                paddingVertical: SPACE.sm, gap: 6,
                borderTopWidth: 1, borderTopColor: C.border, opacity: pressed ? 0.65 : 1,
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: SPACE.sm }}>
                <Text numberOfLines={1} style={{ color: C.text, fontSize: 13.5, fontWeight: "600" }}>{group.name}</Text>
                <Text style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>
                  {group.count} check{group.count === 1 ? "" : "s"}
                </Text>
                <Text style={{
                  marginLeft: "auto", fontSize: T.small, fontWeight: "600",
                  color: group.tone === "failed" ? C.error
                    : group.tone === "running" ? C.warning
                      : group.tone === "fine" ? C.success : C.text4,
                }}>{group.word}</Text>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                {group.squares.map((square, i) => (
                  <View key={i} style={{
                    width: 12, height: 12, borderRadius: 3,
                    backgroundColor: SQUARE[square](),
                    borderWidth: square === "skip" ? 1 : 0, borderColor: C.border2,
                  }} />
                ))}
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <Note>No checks are attached to this pull request yet.</Note>
      )}

      {/* The legend, including the ring: a hollow square and a green one are
          the whole difference between "never ran" and "passed". */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, paddingTop: SPACE.md }}>
        {([
          ["pass", "passed"], ["fail", "failed"], ["run", "running"], ["skip", "does not run"],
        ] as const).map(([square, word]) => (
          <View key={square} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{
              width: 12, height: 12, borderRadius: 3,
              backgroundColor: SQUARE[square](),
              borderWidth: square === "skip" ? 1 : 0, borderColor: C.border2,
            }} />
            <Text style={{ color: C.text3, fontSize: 12 }}>{word}</Text>
          </View>
        ))}
        {required ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{
              width: 14, height: 14, borderRadius: 4, borderWidth: 2, borderColor: C.success,
              backgroundColor: tint(C.success, 0.18),
            }} />
            <Text style={{ color: C.text3, fontSize: 12 }}>required</Text>
          </View>
        ) : null}
      </View>

      <View style={{ paddingTop: SPACE.md }}>
        <Note>
          <Text style={{ fontWeight: "700", color: C.text2 }}>One square is one check.</Text>
          {" "}A ring means the repository requires it; a hollow square means the check never runs on
          this pull request.
        </Note>
      </View>
      {said ? (
        <View style={{ paddingTop: SPACE.sm }}><Note tone="bad">{said}</Note></View>
      ) : null}
    </Sheet>
  );
}
