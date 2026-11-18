/*
 * The windows on this computer, as the approved mock draws them (s05): one list
 * with the ones waiting on you first, what each agent is doing underneath, and
 * a chip for its state. One tap attaches; a long press renames or closes.
 *
 * It used to group by project and carry a search field. The mock opens it on a
 * machine rather than on a project, and every row already names its project in
 * the second line, so the grouping was a heading per project with one window
 * under it. The ceiling is stated: this lists the windows the strip knows,
 * which is every project's, and it cannot show one the server has not listed.
 */
import { Pressable, Text, View } from "react-native";
import type { PendingGate } from "../../../shared/types.ts";
import { gateDetail } from "../model/gates.ts";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { ChevronIcon } from "../nav/icons.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { Sheet, TAP } from "../ui.tsx";
import { StatusDot } from "./StatusDot.tsx";
import type { Tab } from "./tabs.ts";
import { DOT_WORDS, dotOf, groupOf, statusOf, type Dot } from "./windows.ts";

const LEAD: Partial<Record<Dot, { glyph: GlyphName; color: string; chip: string }>> = {
  needs: { glyph: "alert", color: C.warning, chip: "waiting for you" },
  error: { glyph: "alert", color: C.error, chip: "error" },
  working: { glyph: "bot", color: C.primary, chip: "working" },
  done: { glyph: "check", color: C.success, chip: "done" },
  idle: { glyph: "clock", color: C.text3, chip: "idle" },
  none: { glyph: "window", color: C.text2, chip: "no agent" },
};

/** Most urgent first: a stopped agent before a working one, a finished one
 *  before an idle window. The tie is the name, so the list stops moving. */
const RANK: Record<Dot, number> = { needs: 0, error: 1, working: 2, done: 3, idle: 4, none: 5 };

/** "1 working, 2 finished" — the drawing's own words under the roster door. */
function agentLine(tabs: readonly Tab[], asking: ReadonlySet<string>): string {
  const counts = new Map<Dot, number>();
  for (const t of tabs) {
    const dot = dotOf(statusOf(t, asking));
    if (dot === "none") continue;
    counts.set(dot, (counts.get(dot) ?? 0) + 1);
  }
  const word: Partial<Record<Dot, [string, string]>> = {
    working: ["working", "working"],
    done: ["finished", "finished"],
    needs: ["waiting for you", "waiting for you"],
    error: ["error", "errors"],
  };
  const said = (["working", "done", "needs", "error"] as Dot[])
    .filter((d) => counts.has(d))
    .map((d) => `${counts.get(d)} ${word[d]![counts.get(d) === 1 ? 0 : 1]}`);
  return said.length ? said.join(", ") : "Nothing is running";
}

export function WindowSwitcher({ open, onClose, all, active, gates, computer, onPick, onManage, onAgents, newLabel, onNew }: {
  open: boolean;
  onClose: () => void;
  all: readonly Tab[];
  active: string | null;
  gates: readonly PendingGate[];
  /** The machine these windows are on: "Windows on orbit-mini". */
  computer: string;
  onPick: (tab: Tab) => void;
  /** Rename or close this window on the computer, offered on a long press: the
   *  row itself is what you tap to go there. */
  onManage?: (tab: Tab) => void;
  onAgents?: () => void;
  /** "New window in orbit", or null while nothing is open to say where. */
  newLabel: string | null;
  onNew: () => void;
}): React.ReactNode {
  const asking = new Set(gates.flatMap((g) => (g.pane ? [g.pane] : [])));
  const rows = [...all].sort((a, b) => {
    const byRank = RANK[dotOf(statusOf(a, asking))] - RANK[dotOf(statusOf(b, asking))];
    return byRank !== 0 ? byRank : a.name.localeCompare(b.name);
  });
  const gateOf = (tab: Tab): string | undefined => {
    const gate = gates.find((g) => g.pane === tab.paneId);
    return gate ? gateDetail(gate) : undefined;
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Windows on ${computer}`}
      subtitle="What each agent is doing, most urgent first. One tap attaches. A dot is work that arrived since you looked."
      footer={newLabel ? (
        <Pressable
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel={newLabel}
          style={({ pressed }) => ({
            flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
            borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
            backgroundColor: pressed ? C.bg4 : C.bg3,
          })}
        >
          <Glyph name="plus" color={C.text} size={20} />
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{newLabel}</Text>
        </Pressable>
      ) : undefined}
    >
      {rows.length === 0 ? (
        <Text style={{ color: C.text3, fontSize: T.small, paddingVertical: SPACE.lg }}>
          No window is open on the computer.
        </Text>
      ) : rows.map((tab, i) => {
        const status = statusOf(tab, asking);
        const dot = dotOf(status);
        const lead = LEAD[dot]!;
        const here = tab.paneId === active;
        const detail = gateOf(tab);
        return (
          <Pressable
            key={tab.paneId}
            onPress={() => onPick(tab)}
            onLongPress={onManage ? () => onManage(tab) : undefined}
            accessibilityRole="button"
            accessibilityState={{ selected: here }}
            accessibilityLabel={`${tab.name}, ${DOT_WORDS[dot]}${here ? ", here" : ""}`}
            style={({ pressed }) => ({
              minHeight: 58, flexDirection: "row", alignItems: "center", gap: SPACE.md,
              paddingVertical: SPACE.sm,
              borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <View style={{
              width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
              backgroundColor: tint(lead.color, 0.14),
            }}>
              <Glyph name={lead.glyph} color={lead.color} size={17} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
                {tab.name}
              </Text>
              <Text numberOfLines={2} style={{ color: dot === "needs" ? C.warning : C.text3, fontSize: T.small, lineHeight: 17 }}>
                {detail ? `${groupOf(tab)} · ${detail}` : `${groupOf(tab)} · ${DOT_WORDS[dot]}`}
              </Text>
            </View>
            <StatusDot dot={dot} colors={C} />
            <View style={{
              height: 24, paddingHorizontal: SPACE.sm, justifyContent: "center", borderRadius: RADIUS.sm,
              backgroundColor: tint(lead.color, 0.14),
            }}>
              <Text style={{ color: lead.color, fontSize: T.eyebrow, fontWeight: "700" }}>
                {here && dot === "working" ? "working · here" : here ? "here" : lead.chip}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {onAgents ? (
        <>
          <View style={{ height: 1, backgroundColor: C.border, marginVertical: SPACE.sm }} />
          <Pressable
            onPress={onAgents}
            accessibilityRole="button"
            accessibilityLabel="Agents on this computer"
            style={({ pressed }) => ({
              minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.md,
              paddingVertical: SPACE.sm, backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <View style={{
              width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
              backgroundColor: tint(C.primary, 0.14),
            }}>
              <Glyph name="bot" color={C.primary} size={17} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>Agents on {computer}</Text>
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                {agentLine(rows, asking)} · read-only
              </Text>
            </View>
            <ChevronIcon color={C.text4} size={18} />
          </Pressable>
        </>
      ) : null}
    </Sheet>
  );
}
