/*
 * The window switcher: every project's windows, grouped the way the desk
 * groups its strip, opened from the header's title.
 *
 * What to show and in what order is windows.ts. This draws it, and holds the
 * two things that are only about the sheet being open: what is typed in the
 * search and which folded projects the person opened.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PendingGate } from "../../../shared/types.ts";
import { gateDetail } from "../model/gates.ts";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { Sheet, TAP } from "../ui.tsx";
import { StatusDot } from "./StatusDot.tsx";
import type { Tab } from "./tabs.ts";
import { dotOf, groupKey, rowSub, statusOf, switcherGroups, worstOf } from "./windows.ts";

export function WindowSwitcher({ open, onClose, all, active, gates, onPick, onManage, newLabel, onNew }: {
  open: boolean;
  onClose: () => void;
  all: readonly Tab[];
  active: string | null;
  gates: readonly PendingGate[];
  onPick: (tab: Tab) => void;
  /** Rename or close this window on the computer. A button beside the row and
   *  not inside it: the row is what you tap to go there, and a window is
   *  renamed or closed far less often than it is opened. */
  onManage?: (tab: Tab) => void;
  /** "New window in orbit", or null while nothing is open to say where. */
  newLabel: string | null;
  onNew: () => void;
}): React.ReactNode {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // A fresh sheet each time: the last search is not what anybody opens it for.
  useEffect(() => { if (open) { setQuery(""); setExpanded(new Set()); } }, [open]);

  const asking = useMemo(() => new Set(gates.flatMap((g) => (g.pane ? [g.pane] : []))), [gates]);
  const current = all.find((t) => t.paneId === active);
  const groups = switcherGroups(all, {
    query, currentKey: current ? groupKey(current) : null, asking, expanded,
  });
  const detailOf = (tab: Tab): string | undefined => {
    const gate = gates.find((g) => g.pane === tab.paneId);
    return gate ? gateDetail(gate) : undefined;
  };
  const unfold = (key: string): void => setExpanded((was) => new Set([...was, key]));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Windows"
      subtitle="Grouped by project · needs-you first"
      footer={newLabel ? (
        <Pressable
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel={newLabel}
          style={({ pressed }) => ({
            flex: 1, minHeight: TAP, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
            borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
            backgroundColor: pressed ? C.bg4 : C.bg3,
          })}
        >
          <Glyph name="plus" color={C.text} size={20} />
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{newLabel}</Text>
        </Pressable>
      ) : undefined}
    >
      <View style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP, paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg3,
      }}>
        <Glyph name="search" color={C.text3} size={20} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a window or project"
          placeholderTextColor={C.text4}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Find a window or project"
          style={{ flex: 1, minHeight: TAP, color: C.text, fontSize: T.body, paddingVertical: 0 }}
        />
      </View>
      {groups.length === 0 ? (
        <Text style={{ color: C.text3, fontSize: T.small, paddingVertical: SPACE.lg }}>
          {query.trim() ? "No window or project matches that." : "No window is open on the computer."}
        </Text>
      ) : groups.map((group) => (
        <View key={group.key} style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text accessibilityRole="header" style={{ color: C.text2, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>
              {group.label}
              <Text style={{ color: C.text3, fontWeight: "400" }}>{`   ${group.tabs.length} ${group.tabs.length === 1 ? "window" : "windows"}`}</Text>
            </Text>
            {group.needs ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SPACE.sm, height: 24, borderRadius: RADIUS.sm, backgroundColor: tint(C.warning, 0.18) }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.warning }} />
                <Text style={{ color: C.warning, fontSize: T.eyebrow, fontWeight: "700" }}>{group.needs} needs you</Text>
              </View>
            ) : null}
          </View>
          {group.open ? (
            <View style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2, overflow: "hidden" }}>
              {group.tabs.map((tab, i) => {
                const status = statusOf(tab, asking);
                const dot = dotOf(status);
                const sub = rowSub(tab, status, detailOf(tab));
                const here = tab.paneId === active;
                return (
                  <View
                    key={tab.paneId}
                    style={{
                      flexDirection: "row", alignItems: "center",
                      borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                      backgroundColor: here ? tint(C.primary, 0.12) : "transparent",
                    }}
                  >
                    <Pressable
                      onPress={() => onPick(tab)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: here }}
                      accessibilityLabel={`${tab.name}, ${sub}`}
                      style={({ pressed }) => ({
                        flex: 1, minHeight: 60, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                        paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
                        backgroundColor: pressed ? C.bg4 : "transparent",
                      })}
                    >
                      <StatusDot dot={dot} colors={C} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "700" }}>{tab.name}</Text>
                        <Text numberOfLines={1} style={{ color: dot === "needs" ? C.warning : C.text3, fontSize: T.small, fontWeight: dot === "needs" ? "600" : "400" }}>
                          {sub}
                        </Text>
                      </View>
                      {tab.pinned ? <Glyph name="pin" color={C.text3} size={18} /> : null}
                      {here ? <Glyph name="check" color={C.primary} size={20} /> : null}
                    </Pressable>
                    {onManage && tab.windowId ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Rename or close ${tab.label}`}
                        onPress={() => onManage(tab)}
                        style={({ pressed }) => ({
                          width: TAP, height: TAP, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Glyph name="more" color={C.text3} size={20} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : (
            <Pressable
              onPress={() => unfold(group.key)}
              accessibilityRole="button"
              accessibilityLabel={`Show the ${group.tabs.length} windows of ${group.label}`}
              style={({ pressed }) => ({
                minHeight: TAP + 8, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                paddingHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
                backgroundColor: pressed ? C.bg4 : C.bg2,
              })}
            >
              <StatusDot dot={dotOf(worstOf(group.tabs, asking))} colors={C} />
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: T.body, fontWeight: "600" }}>
                {group.tabs.map((t) => t.name).join("   ")}
              </Text>
              <Glyph name="down" color={C.text3} size={20} />
            </Pressable>
          )}
        </View>
      ))}
    </Sheet>
  );
}
