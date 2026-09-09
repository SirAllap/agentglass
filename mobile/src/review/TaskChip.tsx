/*
 * The work item a pull request came from, as four characters at the top of it.
 *
 * The rule for whether it may be shown at all — and what a tap is entitled to
 * do — is `shared/taskref.ts`, shared with the desk so the two cannot drift.
 * What is decided here is only how it looks, and one thing that is not
 * decoration: a chip that opens somewhere ELSE carries the mark saying so.
 * Every other chip on this row is a fact about the pull request; this one is a
 * door, and a door that looks like a label is a tap nobody makes.
 *
 * On a machine that tracks work nowhere, and on a pull request that names
 * nothing, this renders null — no chip, no gap, no placeholder. That case is
 * the majority and it has to feel deliberate rather than broken.
 */
import { useMemo } from "react";
import { Linking, Pressable, Text } from "react-native";
import { chipFor, readTaskRef } from "../../../shared/taskref.ts";
import { C, RADIUS, SPACE, T } from "../theme.ts";

export function TaskChip({ pr, tracked, onFind }: {
  pr: { headRefName?: string; title?: string; body?: string; url?: string };
  /** Whether anything is connected that could resolve a bare id — from the
   *  provider catalogue, never from a product name. Null while unknown. */
  tracked: boolean | null;
  onFind: (query: string, label: string) => void;
}): React.ReactNode {
  const ref = useMemo(
    () => readTaskRef(pr),
    [pr.headRefName, pr.title, pr.body, pr.url],
  );
  const go = useMemo(() => chipFor(ref, tracked), [ref, tracked]);
  if (!ref || !go) return null;

  const away = "open" in go;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={away
        ? `Open ${ref.label}, the item this pull request came from`
        : `Find ${ref.label} in the cards on this machine`}
      onPress={() => {
        if ("open" in go) void Linking.openURL(go.open).catch(() => { /* no app for it */ });
        else onFind(go.find, ref.label);
      }}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 4,
        paddingHorizontal: SPACE.sm, paddingVertical: 2,
        borderRadius: RADIUS.sm, borderWidth: 1, borderColor: C.primary,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: C.primary, fontSize: T.eyebrow, fontWeight: "600" }}>{ref.label}</Text>
      {away ? <Text style={{ color: C.primary, fontSize: T.eyebrow }}>↗</Text> : null}
    </Pressable>
  );
}
